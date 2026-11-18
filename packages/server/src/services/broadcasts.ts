import { validateTemplate } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import { compileSegment, type SegmentRule } from "../segments.js";
import { customVariableKeys } from "./variables.js";
import { preferenceWhere } from "./preferences.js";

/**
 * 一斉配信の宛先条件（区分による出し分けを含む）。
 * - 休眠は常に除外、低下は「重要号」のときだけ含める
 * - 配信停止・一時停止・停止中は除外
 */
export function recipientWhere(
  segment: SegmentRule | null,
  important: boolean,
  params: unknown[],
  topicId: string | null = null,
  now: Date = new Date(),
): string {
  const parts = [
    "c.status = 'active'",
    "c.tier <> 'dormant'",
    important ? "TRUE" : "c.tier <> 'low'",
    // 配信設定：一時停止中は除き、この種類を受け取らないと選んだ読者も除く
    preferenceWhere(topicId, params, now),
  ];
  if (segment) parts.push(`(${compileSegment(segment, params)})`);
  return parts.join(" AND ");
}

export async function countRecipients(
  ctx: AppContext,
  segment: SegmentRule | null,
  important: boolean,
  topicId: string | null = null,
): Promise<number> {
  const params: unknown[] = [];
  const where = recipientWhere(segment, important, params, topicId, ctx.now());
  const [r] = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contacts c
       JOIN channels ch ON ch.contact_id = c.id AND ch.kind = 'email' AND ch.status = 'active'
      WHERE ${where}`,
    params,
  );
  return r?.n ?? 0;
}

export class TemplateError extends Error {
  constructor(readonly unknown: string[]) {
    super(`未登録の置き換え文字があります：${unknown.map((u) => `%${u}%`).join("、")}`);
  }
}

/** 本文と件名の置き換え文字を検証する。 */
export async function assertTemplatesValid(ctx: AppContext, ...templates: string[]): Promise<void> {
  const keys = await customVariableKeys(ctx.db);
  const unknown = new Set<string>();
  for (const t of templates) for (const u of validateTemplate(t, keys).unknown) unknown.add(u);
  if (unknown.size > 0) throw new TemplateError([...unknown]);
}

interface DueBroadcast {
  id: string;
  important: boolean;
  definition: SegmentRule | null;
  topic_id: string | null;
  subject_b: string | null;
  ab_percent: number | null;
  ab_wait_minutes: number | null;
  ab_winner: "a" | "b" | null;
  optimize_send_time: boolean;
}

/** 件名の A/B テストをするか（件名 B と割合が入っているとき） */
export function isAbTest(b: Pick<DueBroadcast, "subject_b" | "ab_percent">): boolean {
  return Boolean(b.subject_b?.trim()) && (b.ab_percent ?? 0) > 0;
}

/**
 * 読者ごとの「よく押す時刻」（日本時間の時）。過去 180 日の人のクリックが 3 回以上ある読者だけ。
 * その時刻の次の回（24 時間以内）を send_after にする。無ければ NULL（予約どおりに送る）。
 */
const SEND_AFTER_SQL = (now: string) => `CASE WHEN bh.h IS NULL THEN NULL ELSE
    ((date_trunc('day', ${now}::timestamptz AT TIME ZONE 'Asia/Tokyo') + make_interval(hours => bh.h)) AT TIME ZONE 'Asia/Tokyo')
    + CASE WHEN ((date_trunc('day', ${now}::timestamptz AT TIME ZONE 'Asia/Tokyo') + make_interval(hours => bh.h)) AT TIME ZONE 'Asia/Tokyo') < ${now}::timestamptz
           THEN interval '1 day' ELSE interval '0' END END`;

const BEST_HOUR_JOIN = (now: string, on: string) => `LEFT JOIN LATERAL (
    SELECT x.h FROM (
      SELECT extract(hour FROM e.occurred_at AT TIME ZONE 'Asia/Tokyo')::int AS h, count(*) AS n, sum(count(*)) OVER () AS total
        FROM events e
       WHERE e.contact_id = c.id AND e.type = 'click' AND e.bot_reason IS NULL AND e.occurred_at > ${now}::timestamptz - interval '180 days'
       GROUP BY 1) x
     WHERE x.total >= 3 ORDER BY x.n DESC, x.h LIMIT 1) bh ON ${on}`;

/**
 * 宛先の読者に送信記録を作る。
 * mode：all＝全員（最適化ありなら読者ごとの時刻）／test＝A/B のテスト分だけ／rest＝決まった件名で残り全員
 */
async function insertRecipients(tx: Db, ctx: AppContext, b: DueBroadcast, mode: "all" | "test" | "rest", now: Date): Promise<string[]> {
  const params: unknown[] = [b.id, ctx.provider.name, now];
  const where = recipientWhere(b.definition, b.important, params, b.topic_id, now);
  if (mode === "test") {
    params.push(b.ab_percent);
    const pct = `$${params.length}::int`;
    // 宛先を決まった順（ランダムだが再現できる）に並べ、先頭から A・B を同じ人数ずつ
    const rows = await tx.query<{ id: string }>(
      `WITH r AS (
         SELECT c.id AS cid, ch.id AS chid, row_number() OVER (ORDER BY md5(c.id::text || $1)) AS n, count(*) OVER () AS total
           FROM contacts c
           JOIN LATERAL (SELECT id FROM channels WHERE contact_id = c.id AND kind = 'email' AND status = 'active' LIMIT 1) ch ON TRUE
          WHERE ${where})
       INSERT INTO messages (idempotency_key, contact_id, channel_id, broadcast_id, provider, kind, queued_at, variant)
       SELECT 'bc:' || $1 || ':' || cid, cid, chid, $1::uuid, $2, 'broadcast', $3,
              CASE WHEN n <= GREATEST(1, floor(total * ${pct} / 200.0)) THEN 'a' ELSE 'b' END
         FROM r WHERE n <= 2 * GREATEST(1, floor(total * ${pct} / 200.0))
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      params,
    );
    return rows.map((r) => r.id);
  }
  params.push(mode === "rest" ? b.ab_winner : null, b.optimize_send_time && mode === "all");
  const variant = `$${params.length - 1}::text`;
  const optimize = `$${params.length}::boolean`;
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO messages (idempotency_key, contact_id, channel_id, broadcast_id, provider, kind, queued_at, variant, send_after)
     SELECT 'bc:' || $1 || ':' || c.id, c.id, ch.id, $1::uuid, $2, 'broadcast', $3, ${variant}, ${SEND_AFTER_SQL("$3")}
       FROM contacts c
       JOIN LATERAL (SELECT id FROM channels WHERE contact_id = c.id AND kind = 'email' AND status = 'active' LIMIT 1) ch ON TRUE
       ${BEST_HOUR_JOIN("$3", optimize)}
      WHERE ${where}
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    params,
  );
  return rows.map((r) => r.id);
}

export interface AbStats {
  variant: "a" | "b";
  total: number;
  sent: number;
  clicked: number;
  opened: number;
}

/** A/B それぞれの送信数・人のクリック数・開封数（機械開封を除く）。テストの分だけ（残りに送った分は含めない） */
export async function abStats(db: Db, broadcastId: string, decidedAt?: Date | null): Promise<AbStats[]> {
  return db.query<AbStats>(
    `SELECT m.variant,
            count(*)::int AS total,
            count(*) FILTER (WHERE m.status IN ('sent','delivered','bounced','complained'))::int AS sent,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'click' AND e.bot_reason IS NULL))::int AS clicked,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'open' AND NOT e.machine))::int AS opened
       FROM messages m
      WHERE m.broadcast_id = $1 AND m.variant IS NOT NULL AND ($2::timestamptz IS NULL OR m.queued_at < $2::timestamptz)
      GROUP BY m.variant ORDER BY m.variant`,
    [broadcastId, decidedAt ?? null],
  );
}

/** 勝ち：人のクリック率が高い方。同じなら開封率（目安）、それも同じなら A */
export function pickWinner(stats: AbStats[]): "a" | "b" {
  const rate = (v: "a" | "b", k: "clicked" | "opened") => {
    const s = stats.find((x) => x.variant === v);
    return s && s.sent > 0 ? s[k] / s.sent : 0;
  };
  if (rate("b", "clicked") !== rate("a", "clicked")) return rate("b", "clicked") > rate("a", "clicked") ? "b" : "a";
  return rate("b", "opened") > rate("a", "opened") ? "b" : "a";
}

/** 予約時刻を過ぎた一斉配信の送信記録（queued）を作り、messages.id を返す。A/B テストの勝ちを決めて残りに送るのもここ。 */
export async function launchDueBroadcasts(ctx: AppContext): Promise<string[]> {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const cols = `b.id, b.important, b.topic_id, COALESCE(b.segment_definition, s.definition) AS definition,
                  b.subject_b, b.ab_percent, b.ab_wait_minutes, b.ab_winner, b.optimize_send_time`;
    const due = await tx.query<DueBroadcast>(
      `SELECT ${cols} FROM broadcasts b LEFT JOIN segments s ON s.id = b.segment_id
        WHERE b.status = 'scheduled' AND b.scheduled_at <= $1
        FOR UPDATE OF b SKIP LOCKED`,
      [now],
    );
    const ids: string[] = [];
    for (const b of due) {
      if (isAbTest(b)) {
        // まずテスト分だけ送り、待ち時間のあとで勝ちを決める
        ids.push(...(await insertRecipients(tx, ctx, b, "test", now)));
        await tx.query("UPDATE broadcasts SET status = 'testing', ab_decide_at = $2 WHERE id = $1", [
          b.id,
          new Date(now.getTime() + (b.ab_wait_minutes ?? 240) * 60_000),
        ]);
        continue;
      }
      await tx.query("UPDATE broadcasts SET status = 'sending' WHERE id = $1", [b.id]);
      ids.push(...(await insertRecipients(tx, ctx, b, "all", now)));
      await tx.query("UPDATE broadcasts SET status = 'sent' WHERE id = $1", [b.id]);
    }

    const toDecide = await tx.query<DueBroadcast>(
      `SELECT ${cols} FROM broadcasts b LEFT JOIN segments s ON s.id = b.segment_id
        WHERE b.status = 'testing' AND b.ab_decide_at <= $1
        FOR UPDATE OF b SKIP LOCKED`,
      [now],
    );
    for (const b of toDecide) {
      const winner = pickWinner(await abStats(tx, b.id));
      await tx.query("UPDATE broadcasts SET ab_winner = $2, ab_decide_at = $3, status = 'sending' WHERE id = $1", [b.id, winner, now]);
      ids.push(...(await insertRecipients(tx, ctx, { ...b, ab_winner: winner }, "rest", now)));
      await tx.query("UPDATE broadcasts SET status = 'sent' WHERE id = $1", [b.id]);
    }
    return ids;
  });
}

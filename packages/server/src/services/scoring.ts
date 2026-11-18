import { computeScore, defaultScoreSettings, type EngagementEvent, type ScoreSettings, type Tier } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import { enroll } from "./sequences.js";

const DAY_MS = 86_400_000;
/** 行動を読み込む期間（半減期30日なら180日でほぼ0になる） */
const EVENT_LOOKBACK_DAYS = 180;
/** 率を計算する期間 */
const RATE_WINDOW_DAYS = 90;
/** 送ってからこの日数は「未反応」と数えない（読む時間を与える） */
const IGNORE_GRACE_DAYS = 3;
const BATCH = 500;

export async function loadScoreSettings(ctx: AppContext): Promise<ScoreSettings> {
  const [row] = await ctx.db.query<{ settings: Partial<ScoreSettings> }>("SELECT settings FROM score_settings WHERE id = 1");
  return { ...defaultScoreSettings, ...(row?.settings ?? {}) };
}

export interface ScoringSummary {
  scored: number;
  newlyDormant: number;
  tiers: Record<Tier, number>;
}

/** 全読者のスコアを再計算する（毎日深夜に実行）。 */
export async function recomputeAllScores(ctx: AppContext): Promise<ScoringSummary> {
  const s = await loadScoreSettings(ctx);
  const now = ctx.now();
  const windowStart = new Date(now.getTime() - RATE_WINDOW_DAYS * DAY_MS);
  const lookback = new Date(now.getTime() - EVENT_LOOKBACK_DAYS * DAY_MS);
  const graceEdge = new Date(now.getTime() - IGNORE_GRACE_DAYS * DAY_MS);

  const [pop] = await ctx.db.query<{ sent: number; clicked: number; read: number }>(
    `SELECT count(*)::int AS sent,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'click' AND e.bot_reason IS NULL))::int AS clicked,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'read'))::int AS read
       FROM messages m WHERE m.kind <> 'optin' AND m.sent_at >= $1`,
    [windowStart],
  );
  const population = {
    clickRate: pop && pop.sent > 0 ? pop.clicked / pop.sent : 0,
    readRate: pop && pop.sent > 0 ? pop.read / pop.sent : 0,
  };

  const [reengage] = await ctx.db.query<{ id: string }>(
    "SELECT id FROM sequences WHERE purpose = 'reengage' AND status = 'active' ORDER BY created_at LIMIT 1",
  );

  const summary: ScoringSummary = { scored: 0, newlyDormant: 0, tiers: { evaluating: 0, hot: 0, normal: 0, low: 0, dormant: 0 } };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const contacts = await ctx.db.query<{ id: string; created_at: Date; tier: Tier; status: string }>(
      `SELECT id, created_at, tier, status FROM contacts
        WHERE status IN ('active','paused','stopped') AND id > $1 ORDER BY id LIMIT $2`,
      [after, BATCH],
    );
    if (contacts.length === 0) break;
    after = contacts.at(-1)!.id;
    const ids = contacts.map((c) => c.id);

    const evRows = await ctx.db.query<{ contact_id: string; type: string; message_id: string | null; machine: boolean; weight: string | null; occurred_at: Date }>(
      `SELECT contact_id, type, message_id, machine, weight, occurred_at FROM events
        WHERE contact_id = ANY($1::uuid[]) AND occurred_at >= $2 AND bot_reason IS NULL
          AND type IN ('click','read','open','goal','reply')`,
      [ids, lookback],
    );
    const msgRows = await ctx.db.query<{ contact_id: string; id: string; sent_at: Date; responded: boolean; clicked: boolean; read: boolean }>(
      `SELECT m.contact_id, m.id, m.sent_at, m.responded,
              EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'click' AND e.bot_reason IS NULL) AS clicked,
              EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'read') AS read
         FROM messages m
        WHERE m.contact_id = ANY($1::uuid[]) AND m.kind <> 'optin' AND m.sent_at >= $2
        ORDER BY m.sent_at DESC`,
      [ids, lookback],
    );

    for (const c of contacts) {
      const events: EngagementEvent[] = evRows
        .filter((e) => e.contact_id === c.id)
        .map((e) => ({
          type: e.type as EngagementEvent["type"],
          occurredAt: new Date(e.occurred_at),
          ...(e.message_id ? { messageId: e.message_id } : {}),
          ...(e.type === "open" ? { machine: e.machine } : {}),
          ...(e.weight !== null ? { weight: Number(e.weight) } : {}),
        }));
      const msgs = msgRows.filter((m) => m.contact_id === c.id);
      for (const m of msgs) {
        if (!m.responded && new Date(m.sent_at) < graceEdge) events.push({ type: "ignored", occurredAt: new Date(m.sent_at) });
      }
      const inWindow = msgs.filter((m) => new Date(m.sent_at) >= windowStart);
      let streak = 0;
      for (const m of msgs) {
        if (new Date(m.sent_at) >= graceEdge) continue;
        if (m.responded) break;
        streak++;
      }
      const result = computeScore(
        {
          now,
          subscribedAt: new Date(c.created_at),
          events,
          window: {
            delivered: inWindow.length,
            clicked: inWindow.filter((m) => m.clicked).length,
            read: inWindow.filter((m) => m.read).length,
          },
          population,
          noResponseStreak: streak,
          previousTier: c.tier,
        },
        s,
      );
      summary.scored++;
      summary.tiers[result.tier]++;

      await ctx.db.transaction(async (tx) => {
        await tx.query("UPDATE contacts SET score = $2, tier = $3, no_response_streak = $4, updated_at = $5 WHERE id = $1", [
          c.id,
          result.score,
          result.tier,
          streak,
          now,
        ]);
        await tx.query(
          `INSERT INTO score_history (contact_id, day, score, tier, breakdown) VALUES ($1, $2::date, $3, $4, $5)
           ON CONFLICT (contact_id, day) DO UPDATE SET score = EXCLUDED.score, tier = EXCLUDED.tier, breakdown = EXCLUDED.breakdown`,
          [c.id, now.toISOString().slice(0, 10), result.score, result.tier, JSON.stringify(result.breakdown)],
        );
        // 新たに休眠になった有効な読者：通常配信を止めて再確認シナリオへ
        if (result.tier === "dormant" && c.tier !== "dormant" && c.status === "active") {
          summary.newlyDormant++;
          if (reengage) {
            await tx.query("UPDATE contacts SET status = 'paused' WHERE id = $1", [c.id]);
            await tx.query(
              "UPDATE enrollments SET status = 'stopped', updated_at = $2 WHERE contact_id = $1 AND status = 'active' AND sequence_id <> $3",
              [c.id, now, reengage.id],
            );
            await enroll(tx, ctx, c.id, reengage.id);
          }
        }
      });
    }
  }
  return summary;
}

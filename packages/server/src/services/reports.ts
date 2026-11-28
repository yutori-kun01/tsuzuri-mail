import type { AppContext } from "../context.js";

/**
 * 送ったメールごとの集計（一斉配信 1 本、シナリオの 1 通、フォームの確認メール）。
 * 配信ログの「メールごと」と、各メールのレポート（開封・クリック・リンク別・読者別）に使う。
 * 開封は人の開封（端末の自動読み込みを除く）、クリックはボットを除いたもの。
 */

export type MailType = "broadcast" | "step" | "optin" | "deleted";
export const MAIL_TYPES: readonly MailType[] = ["broadcast", "step", "optin", "deleted"];

export interface MailStats {
  total: number;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  skipped: number;
  queued: number;
  /** 開封した人（通数ではなく受け取った人の数） */
  opened: number;
  clicked: number;
  /** 受け取ってから 7 日以内に配信停止した人 */
  unsubscribed: number;
}

export interface MailRow extends MailStats {
  type: MailType;
  ref: string;
  title: string | null;
  /** シナリオ名・フォーム名など */
  origin: string | null;
  originId: string | null;
  position: number | null;
  lastAt: Date | null;
}

const HUMAN_OPEN = "EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'open' AND NOT e.machine AND e.bot_reason IS NULL)";
const HUMAN_CLICK = "EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'click' AND e.bot_reason IS NULL)";
const UNSUB = `EXISTS (SELECT 1 FROM events u WHERE u.contact_id = m.contact_id AND u.type = 'unsubscribe'
                AND m.sent_at IS NOT NULL AND u.occurred_at >= m.sent_at AND u.occurred_at < m.sent_at + interval '7 days')`;

const STATS = `count(m.id)::int AS total,
  count(m.id) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent,
  count(m.id) FILTER (WHERE m.status = 'delivered')::int AS delivered,
  count(m.id) FILTER (WHERE m.status = 'bounced')::int AS bounced,
  count(m.id) FILTER (WHERE m.status = 'complained')::int AS complained,
  count(m.id) FILTER (WHERE m.status = 'failed')::int AS failed,
  count(m.id) FILTER (WHERE m.status = 'skipped')::int AS skipped,
  count(m.id) FILTER (WHERE m.status IN ('queued','sending'))::int AS queued,
  count(m.id) FILTER (WHERE ${HUMAN_OPEN})::int AS opened,
  count(m.id) FILTER (WHERE ${HUMAN_CLICK})::int AS clicked,
  count(m.id) FILTER (WHERE ${UNSUB})::int AS unsubscribed,
  max(COALESCE(m.sent_at, m.queued_at)) AS "lastAt"`;

/** 種類ごとの、そのメールの送信記録を選ぶ条件（$1 = ref） */
export function mailFilter(type: MailType): string {
  switch (type) {
    case "broadcast":
      return "m.broadcast_id::text = $1";
    case "step":
      return "m.step_id::text = $1";
    case "optin":
      return "m.kind = 'optin' AND m.form_id::text = $1";
    case "deleted":
      // 元のシナリオ・ステップを削除した通（件名で束ねる）
      return "m.kind = 'sequence' AND m.step_id IS NULL AND COALESCE(m.subject, '') = $1";
  }
}

export async function listMails(ctx: AppContext, o: { type?: MailType; limit: number; offset: number }): Promise<{ rows: MailRow[]; total: number }> {
  const parts: string[] = [];
  if (!o.type || o.type === "broadcast")
    parts.push(`SELECT 'broadcast' AS type, b.id::text AS ref, b.subject AS title, NULL::text AS origin, NULL::text AS "originId", NULL::int AS position, ${STATS}
      FROM messages m JOIN broadcasts b ON b.id = m.broadcast_id GROUP BY b.id, b.subject`);
  if (!o.type || o.type === "step")
    parts.push(`SELECT 'step' AS type, st.id::text AS ref, st.subject AS title, sq.name AS origin, sq.id::text AS "originId", st.position AS position, ${STATS}
      FROM messages m JOIN sequence_steps st ON st.id = m.step_id JOIN sequences sq ON sq.id = st.sequence_id GROUP BY st.id, st.subject, sq.name, sq.id, st.position`);
  if (!o.type || o.type === "optin")
    parts.push(`SELECT 'optin' AS type, f.id::text AS ref, f.confirm_subject AS title, f.name AS origin, f.id::text AS "originId", NULL::int AS position, ${STATS}
      FROM messages m JOIN forms f ON f.id = m.form_id WHERE m.kind = 'optin' GROUP BY f.id, f.confirm_subject, f.name`);
  if (!o.type || o.type === "deleted")
    parts.push(`SELECT 'deleted' AS type, COALESCE(m.subject, '') AS ref, m.subject AS title, NULL::text AS origin, NULL::text AS "originId", NULL::int AS position, ${STATS}
      FROM messages m WHERE m.kind = 'sequence' AND m.step_id IS NULL GROUP BY COALESCE(m.subject, ''), m.subject`);
  const union = parts.join("\nUNION ALL\n");
  const [{ n } = { n: 0 }] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${union}) x`);
  const rows = await ctx.db.query<MailRow>(`SELECT * FROM (${union}) x ORDER BY "lastAt" DESC NULLS LAST LIMIT ${Math.floor(o.limit)} OFFSET ${Math.floor(o.offset)}`);
  return { rows, total: n };
}

export interface MailHeader {
  type: MailType;
  ref: string;
  title: string | null;
  origin: string | null;
  originId: string | null;
  position: number | null;
}

export async function mailHeader(ctx: AppContext, type: MailType, ref: string): Promise<MailHeader | undefined> {
  if (type === "broadcast") {
    const [b] = await ctx.db.query<{ subject: string | null }>("SELECT subject FROM broadcasts WHERE id::text = $1", [ref]);
    return b ? { type, ref, title: b.subject, origin: null, originId: null, position: null } : undefined;
  }
  if (type === "step") {
    const [s] = await ctx.db.query<{ subject: string | null; name: string; sid: string; position: number }>(
      "SELECT st.subject, sq.name, sq.id::text AS sid, st.position FROM sequence_steps st JOIN sequences sq ON sq.id = st.sequence_id WHERE st.id::text = $1",
      [ref],
    );
    return s ? { type, ref, title: s.subject, origin: s.name, originId: s.sid, position: s.position } : undefined;
  }
  if (type === "optin") {
    const [f] = await ctx.db.query<{ confirm_subject: string; name: string }>("SELECT confirm_subject, name FROM forms WHERE id::text = $1", [ref]);
    return f ? { type, ref, title: f.confirm_subject, origin: f.name, originId: ref, position: null } : undefined;
  }
  return { type, ref, title: ref || null, origin: null, originId: null, position: null };
}

export async function mailStats(ctx: AppContext, type: MailType, ref: string): Promise<MailStats & { lastAt: Date | null; firstAt: Date | null }> {
  const [r] = await ctx.db.query<MailStats & { lastAt: Date | null; firstAt: Date | null }>(
    `SELECT ${STATS}, min(m.sent_at) AS "firstAt" FROM messages m WHERE ${mailFilter(type)}`,
    [ref],
  );
  return r!;
}

export interface LinkStats {
  url: string;
  /** 本文での順番（最初に出てくる位置） */
  index: number;
  /** 押した人 */
  clickers: number;
  /** 押された回数（ボットを除く） */
  clicks: number;
}

/** リンクごとのクリック。本文にあったリンクは押されていなくても並べる */
export async function linkStats(ctx: AppContext, type: MailType, ref: string): Promise<LinkStats[]> {
  return ctx.db.query<LinkStats>(
    `WITH ms AS (SELECT m.id, m.links FROM messages m WHERE ${mailFilter(type)}),
          ls AS (SELECT l->>'url' AS url, min((l->>'index')::int) AS idx FROM ms, jsonb_array_elements(ms.links) l GROUP BY l->>'url'),
          cs AS (SELECT e.data->>'url' AS url, count(DISTINCT e.message_id)::int AS clickers, count(*)::int AS clicks
                   FROM events e JOIN ms ON ms.id = e.message_id WHERE e.type = 'click' AND e.bot_reason IS NULL GROUP BY e.data->>'url')
     SELECT COALESCE(ls.url, cs.url) AS url, COALESCE(ls.idx, 9999) AS index, COALESCE(cs.clickers, 0) AS clickers, COALESCE(cs.clicks, 0) AS clicks
       FROM ls FULL JOIN cs ON cs.url = ls.url
      ORDER BY clickers DESC, index`,
    [ref],
  );
}

/** 送ってからの経過時間ごとの開封・クリック（最初の反応の時刻で数える） */
export async function reactionTimeline(ctx: AppContext, type: MailType, ref: string): Promise<{ bucket: number; opened: number; clicked: number }[]> {
  // 0: 1 時間以内 / 1: 6 時間以内 / 2: 24 時間以内 / 3: 3 日以内 / 4: それ以降
  return ctx.db.query(
    `WITH first AS (
       SELECT e.type, min(e.occurred_at) - min(m.sent_at) AS d FROM messages m JOIN events e ON e.message_id = m.id
        WHERE ${mailFilter(type)} AND m.sent_at IS NOT NULL
          AND ((e.type = 'open' AND NOT e.machine AND e.bot_reason IS NULL) OR (e.type = 'click' AND e.bot_reason IS NULL))
        GROUP BY m.id, e.type)
     SELECT CASE WHEN d < interval '1 hour' THEN 0 WHEN d < interval '6 hours' THEN 1 WHEN d < interval '1 day' THEN 2 WHEN d < interval '3 days' THEN 3 ELSE 4 END AS bucket,
            count(*) FILTER (WHERE type = 'open')::int AS opened, count(*) FILTER (WHERE type = 'click')::int AS clicked
       FROM first GROUP BY 1 ORDER BY 1`,
    [ref],
  );
}

export type RecipientFilter = "all" | "opened" | "not_opened" | "clicked" | "not_clicked" | "bounced" | "failed";
export const RECIPIENT_FILTERS: readonly RecipientFilter[] = ["all", "opened", "not_opened", "clicked", "not_clicked", "bounced", "failed"];

export interface RecipientRow {
  message_id: string;
  contact_id: string;
  address: string;
  display_name: string | null;
  status: string;
  error: string | null;
  sent_at: Date | null;
  queued_at: Date;
  first_open: Date | null;
  clicks: number;
  variant: string | null;
}

/** このメールを受け取った読者（開封・クリックの有無で絞れる。url を渡すとそのリンクを押した人だけ） */
export async function recipients(
  ctx: AppContext,
  type: MailType,
  ref: string,
  o: { filter: RecipientFilter; url?: string; limit: number; offset: number },
): Promise<{ rows: RecipientRow[]; total: number }> {
  const params: unknown[] = [ref];
  const cond: string[] = [mailFilter(type)];
  if (o.filter === "opened") cond.push(HUMAN_OPEN);
  if (o.filter === "not_opened") cond.push(`m.sent_at IS NOT NULL AND NOT ${HUMAN_OPEN}`);
  if (o.filter === "clicked") cond.push(HUMAN_CLICK);
  if (o.filter === "not_clicked") cond.push(`m.sent_at IS NOT NULL AND NOT ${HUMAN_CLICK}`);
  if (o.filter === "bounced") cond.push("m.status IN ('bounced','complained')");
  if (o.filter === "failed") cond.push("m.status IN ('failed','skipped')");
  if (o.url) {
    params.push(o.url);
    cond.push(`EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'click' AND e.bot_reason IS NULL AND e.data->>'url' = $${params.length})`);
  }
  const where = cond.join(" AND ");
  const [{ n } = { n: 0 }] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages m WHERE ${where}`, params);
  const rows = await ctx.db.query<RecipientRow>(
    `SELECT m.id AS message_id, m.contact_id, ch.address, c.display_name, m.status, m.error, m.sent_at, m.queued_at, m.variant,
            (SELECT min(e.occurred_at) FROM events e WHERE e.message_id = m.id AND e.type = 'open' AND NOT e.machine AND e.bot_reason IS NULL) AS first_open,
            (SELECT count(*) FROM events e WHERE e.message_id = m.id AND e.type = 'click' AND e.bot_reason IS NULL)::int AS clicks
       FROM messages m JOIN channels ch ON ch.id = m.channel_id JOIN contacts c ON c.id = m.contact_id
      WHERE ${where} ORDER BY COALESCE(m.sent_at, m.queued_at) DESC, m.id LIMIT ${Math.floor(o.limit)} OFFSET ${Math.floor(o.offset)}`,
    params,
  );
  return { rows, total: n };
}

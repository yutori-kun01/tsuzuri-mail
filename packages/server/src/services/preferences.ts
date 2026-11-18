import type { AppContext } from "../context.js";
import type { Db } from "../db.js";

export interface Topic {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  default_subscribed: boolean;
  visible: boolean;
  position: number;
}

export interface ContactPreferences {
  status: string;
  pausedUntil: Date | null;
  topics: (Topic & { subscribed: boolean })[];
}

/** 一時停止で選べる日数 */
export const PAUSE_OPTIONS = [30, 90] as const;

export async function listTopics(db: Db): Promise<Topic[]> {
  return db.query<Topic>("SELECT id, slug, name, description, default_subscribed, visible, position FROM topics ORDER BY position, created_at");
}

export async function getPreferences(ctx: AppContext, contactId: string): Promise<ContactPreferences | undefined> {
  const [c] = await ctx.db.query<{ status: string; paused_until: Date | null }>(
    "SELECT status, paused_until FROM contacts WHERE id::text = $1",
    [contactId],
  );
  if (!c) return undefined;
  const topics = await ctx.db.query<Topic & { subscribed: boolean }>(
    `SELECT t.id, t.slug, t.name, t.description, t.default_subscribed, t.visible, t.position,
            COALESCE(p.subscribed, t.default_subscribed) AS subscribed
       FROM topics t LEFT JOIN contact_topic_prefs p ON p.topic_id = t.id AND p.contact_id::text = $1
      WHERE t.visible ORDER BY t.position, t.created_at`,
    [contactId],
  );
  const paused = c.paused_until && new Date(c.paused_until) > ctx.now() ? new Date(c.paused_until) : null;
  return { status: c.status, pausedUntil: paused, topics };
}

export interface PreferenceUpdate {
  /** 受け取る種類の id（配信設定ページに出ている種類のうち、チェックされたもの） */
  subscribedTopicIds: string[];
  /** 一時停止の日数（0 = 一時停止しない・解除する、"keep" = 今の状態のまま） */
  pauseDays: number | "keep";
}

/**
 * 配信設定を保存する。配信停止済みの読者は変更できない（再登録はフォームから）。
 * 戻り値：保存できたか
 */
export async function savePreferences(ctx: AppContext, contactId: string, u: PreferenceUpdate): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [c] = await tx.query<{ status: string }>("SELECT status FROM contacts WHERE id::text = $1 FOR UPDATE", [contactId]);
    if (!c || c.status === "unsubscribed") return false;
    const now = ctx.now();
    const visible = await tx.query<{ id: string }>("SELECT id FROM topics WHERE visible");
    const chosen = new Set(u.subscribedTopicIds);
    for (const t of visible) {
      await tx.query(
        `INSERT INTO contact_topic_prefs (contact_id, topic_id, subscribed, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (contact_id, topic_id) DO UPDATE SET subscribed = EXCLUDED.subscribed, updated_at = EXCLUDED.updated_at`,
        [contactId, t.id, chosen.has(t.id), now],
      );
    }
    const days = u.pauseDays === "keep" ? "keep" : PAUSE_OPTIONS.includes(u.pauseDays as (typeof PAUSE_OPTIONS)[number]) ? u.pauseDays : 0;
    if (days !== "keep") {
      const until = days > 0 ? new Date(now.getTime() + days * 86_400_000) : null;
      await tx.query("UPDATE contacts SET paused_until = $2, updated_at = $3 WHERE id::text = $1", [contactId, until, now]);
    }
    await tx.query("INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'preferences', $2, $3)", [
      contactId,
      JSON.stringify({ topics: [...chosen], pauseDays: days }),
      now,
    ]);
    return true;
  });
}

/**
 * ある種類（topic）のメールを受け取る読者の条件（contacts の別名 c に対する WHERE 句）。
 * topicId が null なら「種類なし」で、条件は付けない。一時停止中の読者は常に除く。
 */
export function preferenceWhere(topicId: string | null, params: unknown[], now: Date): string {
  params.push(now);
  const notPaused = `(c.paused_until IS NULL OR c.paused_until <= $${params.length})`;
  if (!topicId) return notPaused;
  params.push(topicId);
  const t = `$${params.length}`;
  return `${notPaused} AND COALESCE(
    (SELECT p.subscribed FROM contact_topic_prefs p WHERE p.contact_id = c.id AND p.topic_id = ${t}::uuid),
    (SELECT tp.default_subscribed FROM topics tp WHERE tp.id = ${t}::uuid),
    true)`;
}

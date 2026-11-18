import { idempotencyKey, type Tier } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import { stepSendAt } from "../time.js";

/** 再確認シナリオの最終メールから完了判定までの猶予 */
export const REENGAGE_GRACE_DAYS = 7;

/** ステップの分岐条件。NULL なら全員に送る。 */
export interface StepCondition {
  minScore?: number;
  maxScore?: number;
  tiers?: Tier[];
  hasTags?: string[];
  lacksTags?: string[];
}

interface StepRow {
  id: string;
  position: number;
  delay_days: number;
  send_time: string | null;
  delay_minutes: number | null;
  condition: StepCondition | null;
}

async function stepAt(tx: Db, sequenceId: string, position: number): Promise<StepRow | undefined> {
  const [s] = await tx.query<StepRow>(
    `SELECT id, position, delay_days, send_time::text AS send_time, delay_minutes, condition
       FROM sequence_steps WHERE sequence_id = $1 AND position >= $2 ORDER BY position LIMIT 1`,
    [sequenceId, position],
  );
  return s;
}

/**
 * シナリオに登録する。同じシナリオに進行中なら何もしない。
 * allow_reentry = false で完了済みなら、再登録しない。
 */
export async function enroll(tx: Db, ctx: AppContext, contactId: string, sequenceId: string): Promise<string | undefined> {
  const [seq] = await tx.query<{ status: string; allow_reentry: boolean }>(
    "SELECT status, allow_reentry FROM sequences WHERE id = $1",
    [sequenceId],
  );
  if (!seq || seq.status !== "active") return undefined;
  if (!seq.allow_reentry) {
    const done = await tx.query("SELECT 1 FROM enrollments WHERE contact_id = $1 AND sequence_id = $2", [contactId, sequenceId]);
    if (done.length > 0) return undefined;
  }
  const first = await stepAt(tx, sequenceId, 1);
  if (!first) return undefined;
  const now = ctx.now();
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO enrollments (contact_id, sequence_id, next_position, next_send_at, enrolled_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (contact_id, sequence_id) WHERE status = 'active' DO NOTHING
     RETURNING id`,
    [contactId, sequenceId, first.position, stepSendAt(now, first), now],
  );
  return rows[0]?.id;
}

async function conditionMatches(tx: Db, contactId: string, c: StepCondition | null): Promise<boolean> {
  if (!c) return true;
  const [row] = await tx.query<{ score: string; tier: Tier; tags: string[] }>(
    `SELECT c.score, c.tier,
            COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
       FROM contacts c
       LEFT JOIN contact_tags ct ON ct.contact_id = c.id
       LEFT JOIN tags t ON t.id = ct.tag_id
      WHERE c.id = $1 GROUP BY c.id`,
    [contactId],
  );
  if (!row) return false;
  const score = Number(row.score);
  if (c.minScore !== undefined && score < c.minScore) return false;
  if (c.maxScore !== undefined && score > c.maxScore) return false;
  if (c.tiers && !c.tiers.includes(row.tier)) return false;
  if (c.hasTags && !c.hasTags.every((t) => row.tags.includes(t))) return false;
  if (c.lacksTags && c.lacksTags.some((t) => row.tags.includes(t))) return false;
  return true;
}

async function complete(tx: Db, ctx: AppContext, enrollmentId: string, contactId: string, sequenceId: string): Promise<void> {
  const now = ctx.now();
  await tx.query("UPDATE enrollments SET status = 'completed', next_send_at = NULL, updated_at = $2 WHERE id = $1", [
    enrollmentId,
    now,
  ]);
  const [seq] = await tx.query<{ done_tag_id: string | null; purpose: string; enrolled_at: Date }>(
    `SELECT s.done_tag_id, s.purpose, e.enrolled_at FROM sequences s JOIN enrollments e ON e.id = $2 WHERE s.id = $1`,
    [sequenceId, enrollmentId],
  );
  if (seq?.done_tag_id) {
    await tx.query(
      "INSERT INTO contact_tags (contact_id, tag_id, reason) VALUES ($1, $2, 'sequence') ON CONFLICT DO NOTHING",
      [contactId, seq.done_tag_id],
    );
  }
  // 再確認シナリオを最後まで受け取っても反応がなければ、配信を止める（データは残す）
  if (seq?.purpose === "reengage") {
    const responded = await tx.query(
      "SELECT 1 FROM events WHERE contact_id = $1 AND type IN ('click','read','goal','reply') AND bot_reason IS NULL AND occurred_at >= $2 LIMIT 1",
      [contactId, seq.enrolled_at],
    );
    if (responded.length === 0) {
      await tx.query("UPDATE contacts SET status = 'stopped', updated_at = $2 WHERE id = $1 AND status IN ('active','paused')", [contactId, now]);
    }
  }
}

/**
 * 送信時刻が来たシナリオを処理し、送信記録（queued）を作る。作った messages.id を返す。
 * 複数のワーカーが同時に動いても、行ロック（SKIP LOCKED）と一意キーで重複しない。
 */
export async function scheduleDueSteps(ctx: AppContext, limit = 200): Promise<string[]> {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const due = await tx.query<{
      id: string;
      contact_id: string;
      sequence_id: string;
      next_position: number;
      purpose: string;
      paused_until: Date | null;
      topic_off: boolean;
    }>(
      `SELECT e.id, e.contact_id, e.sequence_id, e.next_position, s.purpose,
              (SELECT paused_until FROM contacts WHERE id = e.contact_id) AS paused_until,
              -- このシナリオの種類を「受け取らない」と選んでいるか
              COALESCE((SELECT NOT p.subscribed FROM contact_topic_prefs p WHERE p.contact_id = e.contact_id AND p.topic_id = s.topic_id),
                       (SELECT NOT t.default_subscribed FROM topics t WHERE t.id = s.topic_id), false) AS topic_off
         FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
        WHERE e.status = 'active' AND e.next_send_at <= $1
        ORDER BY e.next_send_at
        LIMIT $2
        FOR UPDATE OF e SKIP LOCKED`,
      [now, limit],
    );
    const created: string[] = [];
    for (const e of due) {
      const [who] = await tx.query<{ status: string; channel_id: string | null }>(
        `SELECT c.status, (SELECT id FROM channels WHERE contact_id = c.id AND kind = 'email' AND status = 'active' LIMIT 1) AS channel_id
           FROM contacts c WHERE c.id = $1`,
        [e.contact_id],
      );
      // 停止・一時停止中の読者はシナリオも止める（再確認シナリオだけは paused でも進める）
      const sendable = who?.channel_id && (who.status === "active" || (e.purpose === "reengage" && who.status === "paused"));
      if (!sendable) {
        await tx.query("UPDATE enrollments SET status = 'stopped', updated_at = $2 WHERE id = $1", [e.id, now]);
        continue;
      }
      // 配信設定：この種類を受け取らない読者はシナリオを止める。一時停止中は再開日まで先送りする
      if (e.topic_off) {
        await tx.query("UPDATE enrollments SET status = 'stopped', updated_at = $2 WHERE id = $1", [e.id, now]);
        continue;
      }
      if (e.paused_until && new Date(e.paused_until) > now) {
        await tx.query("UPDATE enrollments SET next_send_at = $2, updated_at = $3 WHERE id = $1", [e.id, e.paused_until, now]);
        continue;
      }
      const step = await stepAt(tx, e.sequence_id, e.next_position);
      if (!step) {
        await complete(tx, ctx, e.id, e.contact_id, e.sequence_id);
        continue;
      }
      if (await conditionMatches(tx, e.contact_id, step.condition)) {
        const [m] = await tx.query<{ id: string }>(
          `INSERT INTO messages (idempotency_key, contact_id, channel_id, enrollment_id, step_id, provider, kind, queued_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'sequence', $7)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
          [idempotencyKey.sequenceStep(e.id, step.id), e.contact_id, who.channel_id, e.id, step.id, ctx.provider.name, now],
        );
        if (m) created.push(m.id);
      }
      const next = await stepAt(tx, e.sequence_id, step.position + 1);
      if (next) {
        await tx.query("UPDATE enrollments SET next_position = $2, next_send_at = $3, updated_at = $4 WHERE id = $1", [
          e.id,
          next.position,
          stepSendAt(now, next),
          now,
        ]);
      } else if (e.purpose === "reengage") {
        // 最後の再確認メールに反応する猶予を置いてから完了判定する
        await tx.query("UPDATE enrollments SET next_position = $2, next_send_at = $3, updated_at = $4 WHERE id = $1", [
          e.id,
          step.position + 1,
          new Date(now.getTime() + REENGAGE_GRACE_DAYS * 86_400_000),
          now,
        ]);
      } else {
        await complete(tx, ctx, e.id, e.contact_id, e.sequence_id);
      }
    }
    return created;
  });
}

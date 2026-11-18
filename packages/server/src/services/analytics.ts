import type { AppContext } from "../context.js";

/**
 * シナリオの分析（docs/requirements-2026-11-analytics.md の 3.）。
 * 期間は送信日（ステップ）・登録日（シナリオに入った日）で区切る。
 */

export interface StepStats {
  id: string;
  position: number;
  subject: string;
  sent: number;
  /** 人の開封（端末の自動読み込みを除く。目安） */
  opened: number;
  /** 人のクリック（ボットを除く） */
  clicked: number;
  bounced: number;
  complained: number;
  /** この通を最後に受け取ってから 7 日以内に配信停止した人 */
  unsubscribed: number;
}

export interface RouteStats {
  route: string | null;
  entered: number;
  completed: number;
  clicked: number;
  unsubscribed: number;
}

export interface SequenceAnalytics {
  entered: number;
  active: number;
  completed: number;
  stopped: number;
  unsubscribed: number;
  steps: StepStats[];
  routes: RouteStats[];
}

export async function sequenceAnalytics(ctx: AppContext, sequenceId: string, since: Date): Promise<SequenceAnalytics> {
  const [sum] = await ctx.db.query<{ entered: number; active: number; completed: number; stopped: number }>(
    `SELECT count(*)::int AS entered,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'stopped')::int AS stopped
       FROM enrollments WHERE sequence_id = $1 AND enrolled_at >= $2`,
    [sequenceId, since],
  );
  const steps = await ctx.db.query<StepStats>(
    `SELECT st.id, st.position, COALESCE(st.subject, '') AS subject,
            count(m.id)::int AS sent,
            count(DISTINCT m.id) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'open' AND NOT e.machine AND e.bot_reason IS NULL))::int AS opened,
            count(DISTINCT m.id) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'click' AND e.bot_reason IS NULL))::int AS clicked,
            count(m.id) FILTER (WHERE m.status = 'bounced')::int AS bounced,
            count(m.id) FILTER (WHERE m.status = 'complained')::int AS complained,
            0 AS unsubscribed
       FROM sequence_steps st
       LEFT JOIN messages m ON m.step_id = st.id AND m.sent_at IS NOT NULL AND m.sent_at >= $2
      WHERE st.sequence_id = $1
      GROUP BY st.id, st.position, st.subject ORDER BY st.position`,
    [sequenceId, since],
  );
  // 配信停止を、その人が最後に受け取ったこのシナリオの通に結びつける（7 日以内のものだけ）
  const unsubs = await ctx.db.query<{ step_id: string; n: number }>(
    `SELECT last.step_id, count(*)::int AS n
       FROM events u
       JOIN LATERAL (
         SELECT m.step_id, m.sent_at FROM messages m JOIN sequence_steps st ON st.id = m.step_id
          WHERE m.contact_id = u.contact_id AND st.sequence_id = $1 AND m.sent_at IS NOT NULL AND m.sent_at <= u.occurred_at
          ORDER BY m.sent_at DESC LIMIT 1
       ) last ON last.sent_at > u.occurred_at - interval '7 days'
      WHERE u.type = 'unsubscribe' AND u.occurred_at >= $2
      GROUP BY last.step_id`,
    [sequenceId, since],
  );
  const byStep = new Map(unsubs.map((u) => [u.step_id, u.n]));
  for (const s of steps) s.unsubscribed = byStep.get(s.id) ?? 0;

  const routes = await ctx.db.query<RouteStats>(
    `SELECT r.name AS route,
            count(DISTINCT e.contact_id)::int AS entered,
            count(DISTINCT e.contact_id) FILTER (WHERE e.status = 'completed')::int AS completed,
            count(DISTINCT e.contact_id) FILTER (WHERE EXISTS (
              SELECT 1 FROM events ev JOIN messages m ON m.id = ev.message_id JOIN sequence_steps st ON st.id = m.step_id
               WHERE ev.contact_id = e.contact_id AND ev.type = 'click' AND ev.bot_reason IS NULL AND st.sequence_id = $1))::int AS clicked,
            count(DISTINCT e.contact_id) FILTER (WHERE c.status = 'unsubscribed')::int AS unsubscribed
       FROM enrollments e
       JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN LATERAL (
         SELECT co.route_id FROM consents co JOIN channels ch ON ch.id = co.channel_id JOIN forms f ON f.id = co.form_id
          WHERE ch.contact_id = e.contact_id AND f.sequence_id = $1 ORDER BY co.consented_at DESC LIMIT 1
       ) x ON true
       LEFT JOIN signup_routes r ON r.id = x.route_id
      WHERE e.sequence_id = $1 AND e.enrolled_at >= $2
      GROUP BY r.name ORDER BY count(DISTINCT e.contact_id) DESC`,
    [sequenceId, since],
  );
  return {
    entered: sum?.entered ?? 0,
    active: sum?.active ?? 0,
    completed: sum?.completed ?? 0,
    stopped: sum?.stopped ?? 0,
    unsubscribed: steps.reduce((a, s) => a + s.unsubscribed, 0),
    steps,
    routes,
  };
}

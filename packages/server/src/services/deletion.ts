import type { AppContext } from "../context.js";

/**
 * フォーム・シナリオの削除。
 * 同意の記録（consents）と送信記録（messages）は残す。まだ送っていないメールは送らないようにする。
 */

export interface FormDeletionImpact {
  name: string;
  signups: number;
  pending: number;
  rules: { id: string; name: string }[];
}

export async function formDeletionImpact(ctx: AppContext, formId: string): Promise<FormDeletionImpact | undefined> {
  const [f] = await ctx.db.query<{ name: string; signups: number; pending: number }>(
    `SELECT f.name,
            (SELECT count(*) FROM consents co WHERE co.form_id = f.id)::int AS signups,
            (SELECT count(*) FROM consents co WHERE co.form_id = f.id AND co.confirmed_at IS NULL AND co.revoked_at IS NULL)::int AS pending
       FROM forms f WHERE f.id::text = $1`,
    [formId],
  );
  if (!f) return undefined;
  const rules = await ctx.db.query<{ id: string; name: string }>(
    "SELECT id, name FROM automation_rules WHERE trigger_type = 'form_confirmed' AND trigger_value = $1",
    [formId],
  );
  return { ...f, rules };
}

export async function deleteForm(ctx: AppContext, formId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [f] = await tx.query<{ id: string; slug: string; name: string }>("SELECT id, slug, name FROM forms WHERE id::text = $1 FOR UPDATE", [formId]);
    if (!f) return false;
    const now = ctx.now();
    // どのフォームで同意したかを、同意の記録に書き写してから外す
    await tx.query(
      `UPDATE consents SET evidence = evidence || jsonb_build_object('deleted_form', jsonb_build_object('id', $2::text, 'slug', $3::text, 'name', $4::text, 'deleted_at', $5::text))
        WHERE form_id = $1`,
      [f.id, f.id, f.slug, f.name, now.toISOString()],
    );
    await tx.query("UPDATE messages SET status = 'skipped', error = 'form deleted' WHERE form_id = $1 AND status = 'queued'", [f.id]);
    await tx.query("DELETE FROM automation_rules WHERE trigger_type = 'form_confirmed' AND trigger_value = $1", [f.id]);
    await tx.query("DELETE FROM forms WHERE id = $1", [f.id]);
    return true;
  });
}

export interface SequenceDeletionImpact {
  name: string;
  active: number;
  sent: number;
  queued: number;
  forms: { id: string; name: string }[];
  rules: { id: string; name: string }[];
}

export async function sequenceDeletionImpact(ctx: AppContext, sequenceId: string): Promise<SequenceDeletionImpact | undefined> {
  const [s] = await ctx.db.query<{ name: string; active: number; sent: number; queued: number }>(
    `SELECT s.name,
            (SELECT count(*) FROM enrollments e WHERE e.sequence_id = s.id AND e.status = 'active')::int AS active,
            (SELECT count(*) FROM messages m JOIN sequence_steps st ON st.id = m.step_id WHERE st.sequence_id = s.id AND m.sent_at IS NOT NULL)::int AS sent,
            (SELECT count(*) FROM messages m JOIN sequence_steps st ON st.id = m.step_id WHERE st.sequence_id = s.id AND m.status = 'queued')::int AS queued
       FROM sequences s WHERE s.id::text = $1`,
    [sequenceId],
  );
  if (!s) return undefined;
  const forms = await ctx.db.query<{ id: string; name: string }>("SELECT id, name FROM forms WHERE sequence_id::text = $1 ORDER BY created_at", [sequenceId]);
  const rules = await ctx.db.query<{ id: string; name: string }>(
    `SELECT id, name FROM automation_rules
      WHERE (trigger_type = 'sequence_completed' AND trigger_value = $1) OR (action_type IN ('start_sequence','stop_sequence') AND action_value = $1)`,
    [sequenceId],
  );
  return { ...s, forms, rules };
}

/** シナリオを削除する。withForms なら、このシナリオを始めるフォームも一緒に削除する（同意の記録は残す） */
export async function deleteSequence(ctx: AppContext, sequenceId: string, withForms: boolean): Promise<boolean> {
  const forms = withForms ? await ctx.db.query<{ id: string }>("SELECT id FROM forms WHERE sequence_id::text = $1", [sequenceId]) : [];
  for (const f of forms) await deleteForm(ctx, f.id);
  return ctx.db.transaction(async (tx) => {
    const [s] = await tx.query<{ id: string }>("SELECT id FROM sequences WHERE id::text = $1 FOR UPDATE", [sequenceId]);
    if (!s) return false;
    // まだ送っていない通は送らない（送信記録は「スキップ」として残る）
    await tx.query(
      "UPDATE messages SET status = 'skipped', error = 'sequence deleted' WHERE status = 'queued' AND step_id IN (SELECT id FROM sequence_steps WHERE sequence_id = $1)",
      [s.id],
    );
    // 送信記録に件名を残す（このあと step_id は NULL になる）
    await tx.query(
      "UPDATE messages m SET subject = COALESCE(m.subject, st.subject) FROM sequence_steps st WHERE st.id = m.step_id AND st.sequence_id = $1",
      [s.id],
    );
    await tx.query(
      `DELETE FROM automation_rules
        WHERE (trigger_type = 'sequence_completed' AND trigger_value = $1) OR (action_type IN ('start_sequence','stop_sequence') AND action_value = $1)`,
      [s.id],
    );
    await tx.query("DELETE FROM sequences WHERE id = $1", [s.id]);
    return true;
  });
}

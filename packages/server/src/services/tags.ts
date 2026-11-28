import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import { renameTagInSegment, segmentUsesTag, type SegmentRule } from "../segments.js";
import type { StepCondition } from "./sequences.js";

/**
 * タグの管理（作成・名前の変更・統合・削除）。
 * タグは id で参照する場所（フォームの付与タグ、シナリオの完了タグ）と、名前で参照する場所
 * （自動化のルール、ステップの条件、一斉配信の宛先、保存した宛先）がある。名前を変えるときは後者も合わせて直す。
 */

export interface TagUsage {
  forms: { id: string; name: string }[];
  sequences: { id: string; name: string }[];
  rules: { id: string; name: string }[];
  steps: { id: string; sequence_id: string; sequence: string; position: number }[];
  broadcasts: { id: string; subject: string | null; status: string }[];
  segments: { id: string; name: string }[];
}

/** 名前で参照している場所（消すと動きが変わるもの）があるか */
export function hasNameReferences(u: TagUsage): boolean {
  return u.rules.length + u.steps.length + u.broadcasts.length + u.segments.length > 0;
}

export function renameTagInCondition(c: StepCondition, from: string, to: string): StepCondition {
  const swap = (xs?: string[]) => (xs ? [...new Set(xs.map((x) => (x === from ? to : x)))] : xs);
  const out: StepCondition = { ...c };
  if (c.hasTags) out.hasTags = swap(c.hasTags)!;
  if (c.lacksTags) out.lacksTags = swap(c.lacksTags)!;
  return out;
}

export function conditionUsesTag(c: StepCondition | null, name: string): boolean {
  return !!c && ((c.hasTags ?? []).includes(name) || (c.lacksTags ?? []).includes(name));
}

export async function tagUsage(db: Db, tagId: string): Promise<TagUsage | undefined> {
  const [t] = await db.query<{ name: string }>("SELECT name FROM tags WHERE id::text = $1", [tagId]);
  if (!t) return undefined;
  const name = t.name;
  const forms = await db.query<{ id: string; name: string }>("SELECT id, name FROM forms WHERE tag_id::text = $1 ORDER BY created_at", [tagId]);
  const sequences = await db.query<{ id: string; name: string }>("SELECT id, name FROM sequences WHERE done_tag_id::text = $1 ORDER BY created_at", [tagId]);
  const rules = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM automation_rules
      WHERE (trigger_type = 'tag_added' AND trigger_value = $1) OR (action_type IN ('add_tag','remove_tag') AND action_value = $1) ORDER BY created_at`,
    [name],
  );
  const stepRows = await db.query<{ id: string; sequence_id: string; sequence: string; position: number; condition: StepCondition | null }>(
    "SELECT st.id, st.sequence_id, s.name AS sequence, st.position, st.condition FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id WHERE st.condition IS NOT NULL ORDER BY s.created_at, st.position",
  );
  const bcRows = await db.query<{ id: string; subject: string | null; status: string; segment_definition: SegmentRule | null }>(
    "SELECT id, subject, status, segment_definition FROM broadcasts WHERE status IN ('draft','scheduled','testing','sending') AND segment_definition IS NOT NULL",
  );
  const segRows = await db.query<{ id: string; name: string; definition: SegmentRule }>("SELECT id, name, definition FROM segments");
  return {
    forms,
    sequences,
    rules,
    steps: stepRows.filter((s) => conditionUsesTag(s.condition, name)).map(({ condition: _c, ...s }) => s),
    broadcasts: bcRows.filter((b) => segmentUsesTag(b.segment_definition, name)).map(({ segment_definition: _s, ...b }) => b),
    segments: segRows.filter((s) => segmentUsesTag(s.definition, name)).map(({ definition: _d, ...s }) => s),
  };
}

export type TagResult = { ok: true } | { ok: false; error: string };

export function cleanTagName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

export async function createTag(ctx: AppContext, rawName: string): Promise<TagResult & { id?: string }> {
  const name = cleanTagName(rawName);
  if (!name) return { ok: false, error: "タグの名前を入れてください" };
  const rows = await ctx.db.query<{ id: string }>("INSERT INTO tags (name, category) VALUES ($1, 'cust') ON CONFLICT (name) DO NOTHING RETURNING id", [name]);
  if (!rows[0]) return { ok: false, error: `「${name}」というタグはもうあります` };
  return { ok: true, id: rows[0].id };
}

/** 名前で参照している場所の名前を from → to に書き換える（トランザクションの中で呼ぶ） */
async function rewriteNameReferences(tx: Db, from: string, to: string): Promise<void> {
  await tx.query("UPDATE automation_rules SET trigger_value = $2, updated_at = now() WHERE trigger_type = 'tag_added' AND trigger_value = $1", [from, to]);
  await tx.query("UPDATE automation_rules SET action_value = $2, updated_at = now() WHERE action_type IN ('add_tag','remove_tag') AND action_value = $1", [from, to]);
  const steps = await tx.query<{ id: string; condition: StepCondition }>("SELECT id, condition FROM sequence_steps WHERE condition IS NOT NULL");
  for (const s of steps) {
    if (conditionUsesTag(s.condition, from)) {
      await tx.query("UPDATE sequence_steps SET condition = $2 WHERE id = $1", [s.id, JSON.stringify(renameTagInCondition(s.condition, from, to))]);
    }
  }
  // 送信済みの配信の宛先も直す（後から見たときに、今の名前で表示されるように）
  const bcs = await tx.query<{ id: string; segment_definition: SegmentRule }>("SELECT id, segment_definition FROM broadcasts WHERE segment_definition IS NOT NULL");
  for (const b of bcs) {
    if (segmentUsesTag(b.segment_definition, from)) {
      await tx.query("UPDATE broadcasts SET segment_definition = $2, updated_at = now() WHERE id = $1", [b.id, JSON.stringify(renameTagInSegment(b.segment_definition, from, to))]);
    }
  }
  const segs = await tx.query<{ id: string; definition: SegmentRule }>("SELECT id, definition FROM segments");
  for (const g of segs) {
    if (segmentUsesTag(g.definition, from)) {
      await tx.query("UPDATE segments SET definition = $2, updated_at = now() WHERE id = $1", [g.id, JSON.stringify(renameTagInSegment(g.definition, from, to))]);
    }
  }
}

export async function renameTag(ctx: AppContext, tagId: string, rawName: string): Promise<TagResult> {
  const name = cleanTagName(rawName);
  if (!name) return { ok: false, error: "タグの名前を入れてください" };
  return ctx.db.transaction(async (tx) => {
    const [t] = await tx.query<{ name: string }>("SELECT name FROM tags WHERE id::text = $1", [tagId]);
    if (!t) return { ok: false, error: "タグが見つかりません" };
    if (t.name === name) return { ok: true };
    const [dup] = await tx.query("SELECT 1 FROM tags WHERE name = $1", [name]);
    if (dup) return { ok: false, error: `「${name}」というタグはもうあります。まとめるときは「統合」を使ってください` };
    await tx.query("UPDATE tags SET name = $2 WHERE id::text = $1", [tagId, name]);
    await rewriteNameReferences(tx, t.name, name);
    return { ok: true };
  });
}

/** from のタグを into にまとめる（読者・フォーム・シナリオ・ルール・条件をすべて into に付け替えて from を消す） */
export async function mergeTags(ctx: AppContext, fromId: string, intoId: string): Promise<TagResult> {
  if (fromId === intoId) return { ok: false, error: "同じタグには統合できません" };
  return ctx.db.transaction(async (tx) => {
    const [from] = await tx.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE id::text = $1", [fromId]);
    const [into] = await tx.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE id::text = $1", [intoId]);
    if (!from || !into) return { ok: false, error: "タグが見つかりません" };
    await tx.query(
      `INSERT INTO contact_tags (contact_id, tag_id, reason, tagged_at)
       SELECT contact_id, $2, reason, tagged_at FROM contact_tags WHERE tag_id = $1 ON CONFLICT DO NOTHING`,
      [from.id, into.id],
    );
    await tx.query("UPDATE forms SET tag_id = $2 WHERE tag_id = $1", [from.id, into.id]);
    await tx.query("UPDATE sequences SET done_tag_id = $2, updated_at = now() WHERE done_tag_id = $1", [from.id, into.id]);
    await rewriteNameReferences(tx, from.name, into.name);
    await tx.query("DELETE FROM tags WHERE id = $1", [from.id]);
    return { ok: true };
  });
}

/**
 * タグを削除する。読者からは外れ、フォームの付与タグ・シナリオの完了タグからは外す。
 * 名前で参照している場所（ルール・ステップの条件・未送信の一斉配信・保存した宛先）があるときは、
 * 消すと宛先や動きが変わってしまうので消さない（先にそちらを直すか、統合を使う）。
 */
export async function deleteTag(ctx: AppContext, tagId: string): Promise<TagResult> {
  const usage = await tagUsage(ctx.db, tagId);
  if (!usage) return { ok: false, error: "タグが見つかりません" };
  if (hasNameReferences(usage)) {
    return { ok: false, error: "自動化のルール・ステップの条件・一斉配信の宛先で使っているため削除できません。先にそちらを外すか、別のタグに統合してください" };
  }
  await ctx.db.transaction(async (tx) => {
    await tx.query("UPDATE forms SET tag_id = NULL WHERE tag_id::text = $1", [tagId]);
    await tx.query("UPDATE sequences SET done_tag_id = NULL, updated_at = now() WHERE done_tag_id::text = $1", [tagId]);
    await tx.query("DELETE FROM tags WHERE id::text = $1", [tagId]);
  });
  return { ok: true };
}

export interface TagRow {
  id: string;
  name: string;
  category: string;
  total: number;
  active: number;
  usage: TagUsage;
}

/** タグの一覧と、それぞれを使っている場所（一覧用にまとめて読む） */
export async function listTagsWithUsage(db: Db): Promise<TagRow[]> {
  const tags = await db.query<{ id: string; name: string; category: string; total: number; active: number }>(
    `SELECT t.id, t.name, t.category,
            (SELECT count(*) FROM contact_tags ct WHERE ct.tag_id = t.id)::int AS total,
            (SELECT count(*) FROM contact_tags ct JOIN contacts co ON co.id = ct.contact_id WHERE ct.tag_id = t.id AND co.status = 'active')::int AS active
       FROM tags t ORDER BY t.name`,
  );
  const forms = await db.query<{ id: string; name: string; tag_id: string | null }>("SELECT id, name, tag_id FROM forms WHERE tag_id IS NOT NULL ORDER BY created_at");
  const seqs = await db.query<{ id: string; name: string; done_tag_id: string | null }>("SELECT id, name, done_tag_id FROM sequences WHERE done_tag_id IS NOT NULL ORDER BY created_at");
  const rules = await db.query<{ id: string; name: string; trigger_type: string; trigger_value: string; action_type: string; action_value: string }>(
    "SELECT id, name, trigger_type, trigger_value, action_type, action_value FROM automation_rules ORDER BY created_at",
  );
  const steps = await db.query<{ id: string; sequence_id: string; sequence: string; position: number; condition: StepCondition | null }>(
    "SELECT st.id, st.sequence_id, s.name AS sequence, st.position, st.condition FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id WHERE st.condition IS NOT NULL ORDER BY s.created_at, st.position",
  );
  const bcs = await db.query<{ id: string; subject: string | null; status: string; segment_definition: SegmentRule | null }>(
    "SELECT id, subject, status, segment_definition FROM broadcasts WHERE status IN ('draft','scheduled','testing','sending') AND segment_definition IS NOT NULL",
  );
  const segs = await db.query<{ id: string; name: string; definition: SegmentRule }>("SELECT id, name, definition FROM segments");
  return tags.map((t) => ({
    ...t,
    usage: {
      forms: forms.filter((f) => f.tag_id === t.id).map(({ id, name }) => ({ id, name })),
      sequences: seqs.filter((s) => s.done_tag_id === t.id).map(({ id, name }) => ({ id, name })),
      rules: rules
        .filter((r) => (r.trigger_type === "tag_added" && r.trigger_value === t.name) || ((r.action_type === "add_tag" || r.action_type === "remove_tag") && r.action_value === t.name))
        .map(({ id, name }) => ({ id, name })),
      steps: steps.filter((s) => conditionUsesTag(s.condition, t.name)).map(({ condition: _c, ...s }) => s),
      broadcasts: bcs.filter((b) => segmentUsesTag(b.segment_definition, t.name)).map(({ segment_definition: _s, ...b }) => b),
      segments: segs.filter((g) => segmentUsesTag(g.definition, t.name)).map(({ definition: _d, ...g }) => g),
    },
  }));
}

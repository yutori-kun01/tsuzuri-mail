import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import { enroll } from "./sequences.js";

export type TriggerType = "link_click" | "tag_added" | "sequence_completed" | "form_confirmed" | "purchased" | "refunded";
export type ActionType = "add_tag" | "remove_tag" | "start_sequence" | "stop_sequence";

export interface Rule {
  id: string;
  name: string;
  trigger_type: TriggerType;
  trigger_value: string;
  action_type: ActionType;
  action_value: string;
  active: boolean;
}

export const TRIGGERS: Record<TriggerType, string> = {
  link_click: "リンクを押したとき",
  tag_added: "タグが付いたとき",
  sequence_completed: "シナリオを最後まで受け取ったとき",
  form_confirmed: "フォームで登録が完了したとき",
  purchased: "商品を買ったとき",
  refunded: "商品の代金が全額返金されたとき",
};

export const ACTIONS: Record<ActionType, string> = {
  add_tag: "タグを付ける",
  remove_tag: "タグを外す",
  start_sequence: "シナリオを始める",
  stop_sequence: "シナリオを止める",
};

/** 1 回の処理で、少し前までさかのぼって見直す幅（取りこぼし防止。同じルールは同じ読者に 1 回だけなので重複しない） */
const LOOKBACK_MS = 10 * 60_000;
const STATE_KEY = "automations.last_run";

interface Hit {
  contactId: string;
  type: TriggerType;
  /** link_click は URL、tag_added はタグ名、ほかは id */
  value: string;
}

/** きっかけ（クリック・タグ・シナリオ完了・登録完了・購入・返金）を集める */
async function collectHits(db: Db, from: Date, to: Date): Promise<Hit[]> {
  const hits: Hit[] = [];
  const clicks = await db.query<{ contact_id: string; url: string | null }>(
    `SELECT contact_id, data->>'url' AS url FROM events
      WHERE type = 'click' AND bot_reason IS NULL AND occurred_at > $1 AND occurred_at <= $2`,
    [from, to],
  );
  for (const c of clicks) if (c.url) hits.push({ contactId: c.contact_id, type: "link_click", value: c.url });
  const tags = await db.query<{ contact_id: string; name: string }>(
    `SELECT ct.contact_id, t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.tagged_at > $1 AND ct.tagged_at <= $2`,
    [from, to],
  );
  for (const t of tags) hits.push({ contactId: t.contact_id, type: "tag_added", value: t.name });
  const done = await db.query<{ contact_id: string; sequence_id: string }>(
    `SELECT contact_id, sequence_id::text FROM enrollments WHERE status = 'completed' AND updated_at > $1 AND updated_at <= $2`,
    [from, to],
  );
  for (const d of done) hits.push({ contactId: d.contact_id, type: "sequence_completed", value: d.sequence_id });
  const confirmed = await db.query<{ contact_id: string; form_id: string }>(
    `SELECT ch.contact_id, co.form_id::text FROM consents co JOIN channels ch ON ch.id = co.channel_id
      WHERE co.form_id IS NOT NULL AND co.confirmed_at > $1 AND co.confirmed_at <= $2`,
    [from, to],
  );
  for (const c of confirmed) hits.push({ contactId: c.contact_id, type: "form_confirmed", value: c.form_id });
  const bought = await db.query<{ contact_id: string; product_id: string; refunded: boolean }>(
    `SELECT contact_id, product_id::text, false AS refunded FROM entitlements WHERE granted_at > $1 AND granted_at <= $2
     UNION ALL
     SELECT contact_id, product_id::text, true AS refunded FROM entitlements WHERE revoked_at > $1 AND revoked_at <= $2`,
    [from, to],
  );
  for (const b of bought) hits.push({ contactId: b.contact_id, type: b.refunded ? "refunded" : "purchased", value: b.product_id });
  return hits;
}

export function ruleMatches(rule: Pick<Rule, "trigger_type" | "trigger_value">, hit: Pick<Hit, "type" | "value">): boolean {
  if (rule.trigger_type !== hit.type) return false;
  // リンクは「この文字を含む URL」。それ以外は完全一致
  return rule.trigger_type === "link_click" ? hit.value.includes(rule.trigger_value) : hit.value === rule.trigger_value;
}

async function tagId(tx: Db, name: string): Promise<string> {
  const [t] = await tx.query<{ id: string }>(
    "INSERT INTO tags (name, category) VALUES ($1, 'cust') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [name],
  );
  return t!.id;
}

async function act(tx: Db, ctx: AppContext, rule: Rule, contactId: string): Promise<void> {
  switch (rule.action_type) {
    case "add_tag":
      await tx.query("INSERT INTO contact_tags (contact_id, tag_id, reason, tagged_at) VALUES ($1, $2, 'rule', $3) ON CONFLICT DO NOTHING", [
        contactId,
        await tagId(tx, rule.action_value),
        ctx.now(),
      ]);
      return;
    case "remove_tag":
      await tx.query("DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = (SELECT id FROM tags WHERE name = $2)", [contactId, rule.action_value]);
      return;
    case "start_sequence": {
      // 配信中の読者だけ（配信停止した人にシナリオを始めない）
      const [c] = await tx.query<{ status: string }>("SELECT status FROM contacts WHERE id = $1", [contactId]);
      if (c?.status === "active") await enroll(tx, ctx, contactId, rule.action_value);
      return;
    }
    case "stop_sequence":
      await tx.query(
        "UPDATE enrollments SET status = 'stopped', updated_at = $3 WHERE contact_id = $1 AND sequence_id::text = $2 AND status = 'active'",
        [contactId, rule.action_value, ctx.now()],
      );
      return;
  }
}

/**
 * 自動化のルールを動かす（毎分）。前回から今までに起きたきっかけを集め、合うルールを、同じ読者に 1 回だけ実行する。
 * ルールが付けたタグが次のルールのきっかけになる場合は、次の回（約 1 分後）に動く。
 */
export async function runAutomations(ctx: AppContext): Promise<{ ran: number }> {
  const now = ctx.now();
  const rules = await ctx.db.query<Rule>("SELECT * FROM automation_rules WHERE active");
  const [state] = await ctx.db.query<{ value: string }>("SELECT value FROM automation_state WHERE key = $1", [STATE_KEY]);
  const last = state ? new Date(state.value) : new Date(now.getTime() - LOOKBACK_MS);
  const from = new Date(Math.min(last.getTime(), now.getTime()) - LOOKBACK_MS);
  let ran = 0;
  if (rules.length) {
    const hits = await collectHits(ctx.db, from, now);
    for (const hit of hits) {
      for (const rule of rules.filter((r) => ruleMatches(r, hit))) {
        const did = await ctx.db.transaction(async (tx) => {
          const [first] = await tx.query(
            "INSERT INTO automation_runs (rule_id, contact_id, ran_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING rule_id",
            [rule.id, hit.contactId, now],
          );
          if (!first) return false;
          await act(tx, ctx, rule, hit.contactId);
          return true;
        });
        if (did) ran++;
      }
    }
  }
  await ctx.db.query(
    "INSERT INTO automation_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [STATE_KEY, now.toISOString()],
  );
  return { ran };
}

/** ルールを人が読める文にする（例：「https://… を含むリンクを押したとき → タグ「講座」を付ける」） */
export function describeRule(r: Pick<Rule, "trigger_type" | "trigger_value" | "action_type" | "action_value">, names: Map<string, string>): [string, string] {
  const v = (id: string) => names.get(id) ?? "（削除済み）";
  const trigger =
    r.trigger_type === "link_click"
      ? `「${r.trigger_value}」を含むリンクを押したとき`
      : r.trigger_type === "tag_added"
        ? `タグ「${r.trigger_value}」が付いたとき`
        : r.trigger_type === "sequence_completed"
          ? `シナリオ「${v(r.trigger_value)}」を最後まで受け取ったとき`
          : r.trigger_type === "purchased"
            ? `商品「${v(r.trigger_value)}」を買ったとき`
            : r.trigger_type === "refunded"
              ? `商品「${v(r.trigger_value)}」の代金が全額返金されたとき`
              : `フォーム「${v(r.trigger_value)}」で登録が完了したとき`;
  const action =
    r.action_type === "add_tag"
      ? `タグ「${r.action_value}」を付ける`
      : r.action_type === "remove_tag"
        ? `タグ「${r.action_value}」を外す`
        : r.action_type === "start_sequence"
          ? `シナリオ「${v(r.action_value)}」を始める`
          : `シナリオ「${v(r.action_value)}」を止める`;
  return [trigger, action];
}

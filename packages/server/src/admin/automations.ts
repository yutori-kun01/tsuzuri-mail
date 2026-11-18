import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { ACTIONS, describeRule, TRIGGERS, type ActionType, type Rule, type TriggerType } from "../services/automations.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm, tagsWithCounts } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, pageHeader } from "./ui.js";

/** 本文に書かれているリンク（ルールの入力候補） */
async function knownUrls(ctx: AppContext): Promise<string[]> {
  const rows = await ctx.db.query<{ body: string }>(
    `SELECT body_markdown AS body FROM broadcasts UNION ALL SELECT body_markdown FROM sequence_steps`,
  );
  const urls = new Set<string>();
  for (const r of rows) for (const m of r.body.matchAll(/https?:\/\/[^\s)"'<>]+/g)) urls.add(m[0]);
  return [...urls].slice(0, 100);
}

/** 名前の一覧（シナリオ・フォームの id → 名前） */
export async function ruleNames(ctx: AppContext): Promise<Map<string, string>> {
  const rows = await ctx.db.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM sequences UNION ALL SELECT id::text, name FROM forms",
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function registerAutomations(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/automations", async (c) => {
    const ctx = await getCtx();
    const rules = await ctx.db.query<Rule & { runs: number }>(
      "SELECT r.*, (SELECT count(*) FROM automation_runs x WHERE x.rule_id = r.id)::int AS runs FROM automation_rules r ORDER BY r.created_at",
    );
    const names = await ruleNames(ctx);
    const seqs = await ctx.db.query<{ id: string; name: string; status: string }>("SELECT id, name, status FROM sequences ORDER BY created_at");
    const forms = await ctx.db.query<{ id: string; name: string }>("SELECT id, name FROM forms ORDER BY created_at");
    const tags = await tagsWithCounts(ctx);
    const urls = await knownUrls(ctx);
    const opt = (v: string, l: string) => `<option value="${h(v)}">${h(l)}</option>`;

    const cards = rules
      .map((r) => {
        const [when, then] = describeRule(r, names);
        return `<section class="card rule${r.active ? "" : " off"}"><div class="rule-line">
<span class="rule-chip when"><small>もし</small>${icon("zap", 14)}${h(when)}</span><span class="rule-arrow">${icon("arrow-right", 16)}</span><span class="rule-chip then"><small>したら</small>${h(then)}</span></div>
<div class="rule-foot"><span class="muted">${r.active ? '<span class="pill good">動作中</span>' : '<span class="pill">停止中</span>'}${r.name !== `${when} → ${then}`.slice(0, 60) ? `${h(r.name)}・` : ""}これまでに ${r.runs} 人が対象になりました</span><div class="actions" style="margin:0">
<form method="post" action="/admin/automations/${h(r.id)}/active" class="inline"><input type="hidden" name="active" value="${r.active ? "0" : "1"}"><button type="submit" class="${r.active ? "sub" : ""}">${icon(r.active ? "power-off" : "power", 16)}${r.active ? "止める" : "動かす"}</button></form>
<form method="post" action="/admin/automations/${h(r.id)}/delete" class="inline" onsubmit="return confirm('このルールを削除しますか？')"><button class="danger" type="submit">削除</button></form></div></div></section>`;
      })
      .join("");

    // よく使う形：押すと下の作成欄に入る
    const presets: { label: string; trigger: TriggerType; action: ActionType; hint: string }[] = [
      { label: "リンクを押した人にタグを付ける", trigger: "link_click", action: "add_tag", hint: "本文の「詳しくはこちら」を押した → タグ「○○に興味」" },
      { label: "タグが付いたらシナリオを始める", trigger: "tag_added", action: "start_sequence", hint: "タグ「○○に興味」 → 案内のシナリオ" },
      { label: "シナリオを終えたら次のシナリオへ", trigger: "sequence_completed", action: "start_sequence", hint: "特典のシナリオ完了 → 本編のシナリオ" },
      { label: "申込リンクを押したら案内を止める", trigger: "link_click", action: "stop_sequence", hint: "申込ページを押した → 案内のシナリオを止める" },
    ];
    const builder = `<details class="card add-step" id="new-rule"${rules.length ? "" : " open"}><summary>${icon("plus", 16)}ルールを作る</summary>
<p class="muted" style="margin:0 0 8px">よく使う形から選ぶと、下の欄に入ります。</p>
<div class="preset-row">${presets
      .map((p) => `<button type="button" class="preset" data-trigger="${p.trigger}" data-action="${p.action}"><b>${h(p.label)}</b><span>${h(p.hint)}</span></button>`)
      .join("")}</div>
<form method="post" action="/admin/automations" id="rule-form">
<div class="rule-build">
<div class="build-card when"><div class="build-title">${icon("zap", 16)}もし（きっかけ）</div><select id="trigger_type" name="trigger_type" aria-label="きっかけ" onchange="tzShow(this,'t-')">${(Object.keys(TRIGGERS) as TriggerType[]).map((k) => opt(k, TRIGGERS[k])).join("")}</select>
<div class="t-link_click"><label for="link_url">押されたリンク（この文字を含む URL）</label><input id="link_url" type="text" name="link_url" list="url-list" placeholder="https://example.com/course">
<datalist id="url-list">${urls.map((u) => `<option value="${h(u)}"></option>`).join("")}</datalist>
<p class="muted" style="margin:4px 0 0">一斉配信・シナリオの本文に書いたリンクが候補に出ます。ボットのクリックは数えません。</p></div>
<div class="t-tag_added" hidden><label for="trigger_tag">付いたタグ</label><input id="trigger_tag" type="text" name="trigger_tag" list="tag-list" maxlength="40"></div>
<div class="t-sequence_completed" hidden><label for="trigger_seq">シナリオ</label><select id="trigger_seq" name="trigger_seq">${seqs.map((s) => opt(s.id, s.name)).join("")}</select></div>
<div class="t-form_confirmed" hidden><label for="trigger_form">フォーム</label><select id="trigger_form" name="trigger_form">${forms.map((f) => opt(f.id, f.name)).join("")}</select></div>
</div>
<div class="rule-arrow big">${icon("arrow-right", 22)}</div>
<div class="build-card then"><div class="build-title">${icon("workflow", 16)}したら（動作）</div><select id="action_type" name="action_type" aria-label="動作" onchange="tzShow(this,'a-')">${(Object.keys(ACTIONS) as ActionType[]).map((k) => opt(k, ACTIONS[k])).join("")}</select>
<div class="a-add_tag a-remove_tag"><label for="action_tag">タグ</label><input id="action_tag" type="text" name="action_tag" list="tag-list" maxlength="40" placeholder="例：講座に興味"></div>
<div class="a-start_sequence a-stop_sequence" hidden><label for="action_seq">シナリオ</label><select id="action_seq" name="action_seq">${seqs.map((s) => opt(s.id, `${s.name}${s.status === "active" ? "" : "（配信中ではない）"}`)).join("")}</select></div>
</div></div>
<datalist id="tag-list">${tags.map((t) => `<option value="${h(t.name)}"></option>`).join("")}</datalist>
<label for="rule-name">名前（任意。一覧で見分けるため）</label><input id="rule-name" type="text" name="name" maxlength="60">
<div class="actions"><button type="submit">${icon("zap", 16)}ルールを作る</button></div></form></details>
<script>function tzShow(sel,p){for(const el of document.querySelectorAll('#rule-form [class^="'+p+'"],#rule-form [class*=" '+p+'"]')){el.hidden=!el.className.split(' ').includes(p+sel.value)}}
document.querySelectorAll('.preset').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById('trigger_type'),a=document.getElementById('action_type');t.value=b.dataset.trigger;a.value=b.dataset.action;tzShow(t,'t-');tzShow(a,'a-');var f=document.querySelector('#rule-form .t-'+b.dataset.trigger+' input,#rule-form .t-'+b.dataset.trigger+' select');if(f)f.focus()})});
document.querySelectorAll('[data-open]').forEach(function(a){a.addEventListener('click',function(e){var d=document.getElementById(a.dataset.open);if(d){e.preventDefault();d.open=true;d.scrollIntoView({behavior:'smooth',block:'start'})}})});</script>`;

    const body = `${pageHeader({
      title: "自動化",
      desc: "「もし○○したら△△する」を決めておくと、毎分自動で動きます。同じルールは同じ読者に 1 回だけ動きます。",
      actions: `<a class="btn" href="#new-rule" data-open="new-rule">${icon("plus", 16)}ルールを作る</a>`,
    })}
<style>
.rule-chip small{font:600 11px/1 var(--font-sans);opacity:.85;margin-right:2px}
.rule-foot .pill{margin-right:var(--space-2)}
.build-card{border-radius:var(--radius-sm);padding:var(--space-3) var(--space-4);border-left:4px solid}
.build-card.when{background:var(--warning-soft);border-color:var(--warning)}.build-card.when .build-title{color:var(--warning)}
.build-card.then{background:var(--accent-soft);border-color:var(--accent)}.build-card.then .build-title{color:var(--accent)}
.build-title{display:flex;align-items:center;gap:var(--space-2);font-weight:600;margin-bottom:var(--space-2)}
.preset-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--space-2);margin-bottom:var(--space-4)}
.preset{display:flex;flex-direction:column;align-items:flex-start;gap:2px;height:auto;padding:var(--space-2) var(--space-3);background:var(--surface);color:var(--ink);border:1px solid var(--line);text-align:left;white-space:normal;font-weight:400}
.preset:hover{border-color:var(--accent);filter:none;background:var(--accent-soft)}
.preset b{font-size:13px}.preset span{font-size:12px;color:var(--ink-muted)}
</style>
${builder}
${rules.length ? cards : emptyState({ icon: "zap", title: "まだルールがありません", text: "上の「よく使う形」から選ぶと簡単に作れます。" })}`;
    return c.html(adminPage({ title: "自動化", active: "/admin/automations", body, flash: flashFrom(c) }));
  });

  app.post("/automations", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const trigger = one(f, "trigger_type") as TriggerType;
    const action = one(f, "action_type") as ActionType;
    if (!(trigger in TRIGGERS) || !(action in ACTIONS)) return back(c, "/admin/automations", "err", "きっかけと動作を選んでください");
    const triggerValue = {
      link_click: one(f, "link_url"),
      tag_added: one(f, "trigger_tag"),
      sequence_completed: one(f, "trigger_seq"),
      form_confirmed: one(f, "trigger_form"),
    }[trigger];
    const actionValue = action === "add_tag" || action === "remove_tag" ? one(f, "action_tag") : one(f, "action_seq");
    if (!triggerValue) return back(c, "/admin/automations", "err", trigger === "link_click" ? "押されたリンクの URL（の一部）を入れてください" : "きっかけの対象を選んでください");
    if (!actionValue) return back(c, "/admin/automations", "err", "付ける・外すタグ、または始める・止めるシナリオを選んでください");
    if (trigger === "link_click" && triggerValue.length < 8) return back(c, "/admin/automations", "err", "URL は 8 文字以上にしてください（短すぎると関係ないリンクにも反応するため）");
    if (actionValue.length > 200 || triggerValue.length > 500) return back(c, "/admin/automations", "err", "入力が長すぎます");
    if (trigger === "tag_added" && (action === "add_tag" || action === "remove_tag") && triggerValue === actionValue)
      return back(c, "/admin/automations", "err", "きっかけと同じタグは付け外しできません");
    const [when, then] = describeRule({ trigger_type: trigger, trigger_value: triggerValue, action_type: action, action_value: actionValue }, await ruleNames(ctx));
    const [row] = await ctx.db.query<{ id: string }>(
      "INSERT INTO automation_rules (name, trigger_type, trigger_value, action_type, action_value) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [one(f, "name") || `${when} → ${then}`.slice(0, 60), trigger, triggerValue, action, actionValue],
    );
    await audit(ctx.db, "automation.create", row!.id);
    return back(c, "/admin/automations", "ok", "ルールを作りました。これから起きることに対して動きます");
  });

  app.post("/automations/:id/active", async (c) => {
    const ctx = await getCtx();
    const active = one(await readForm(c), "active") === "1";
    await ctx.db.query("UPDATE automation_rules SET active = $2, updated_at = now() WHERE id::text = $1", [c.req.param("id"), active]);
    await audit(ctx.db, active ? "automation.start" : "automation.stop", c.req.param("id"));
    return back(c, "/admin/automations", "ok", active ? "ルールを動かしました" : "ルールを止めました");
  });

  app.post("/automations/:id/delete", async (c) => {
    const ctx = await getCtx();
    await ctx.db.query("DELETE FROM automation_rules WHERE id::text = $1", [c.req.param("id")]);
    await audit(ctx.db, "automation.delete", c.req.param("id"));
    return back(c, "/admin/automations", "ok", "削除しました");
  });
}

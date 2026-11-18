import { buildFields, FIELD_TYPE_LABELS, FIELD_TYPES, NAME_FIELD_KEY, normalizeFields, type BodyFormat, type FieldType, type FormField, type Tier } from "@tsuzuri/core";
import type { Hono } from "hono";
import { url, type AppContext } from "../context.js";
import { embedSnippet, formPage } from "../http/pages.js";
import { assertTemplatesValid, TemplateError } from "../services/broadcasts.js";
import type { StepCondition } from "../services/sequences.js";
import { listTopics } from "../services/preferences.js";
import { audit } from "./auth.js";
import { back, flashFrom, list, many, one, previewResponse, readForm, readSenderFields, renderSample, senderFieldsHtml, sendTest, tagsFrom, tagsWithCounts, type Form } from "./common.js";
import { listFooters } from "../services/footers.js";
import { footerSelect } from "./footers.js";
import { describeRule, type Rule } from "../services/automations.js";
import { ruleNames } from "./automations.js";
import { icon } from "./icons.js";
import { describeTiming } from "../time.js";
import { listRoutes, PERIODS, periodStart } from "./routes.js";
import { analyticsPanel } from "./analytics.js";
import { sequenceAnalytics } from "../services/analytics.js";
import { adminPage, emptyState, fromJstInput, h, linkButton, pageHeader, pct, statusPill, tagPicker, TIERS, toJstInput, topicPicker } from "./ui.js";
import type { IconName } from "./icons.js";

/** シナリオ画面の区分（左のメニュー） */
const SEQ_TABS: { key: string; label: string; icon: IconName }[] = [
  { key: "steps", label: "ステップ", icon: "workflow" },
  { key: "analytics", label: "分析", icon: "chart-no-axes-column" },
  { key: "forms", label: "登録フォーム", icon: "file-input" },
  { key: "settings", label: "基本設定", icon: "settings" },
  { key: "sender", label: "送信者", icon: "mail" },
];

/** フォーム編集画面の区分（左のメニュー） */
const FORM_TABS: { key: string; label: string; icon: IconName }[] = [
  { key: "basic", label: "基本設定", icon: "settings" },
  { key: "fields", label: "入力項目", icon: "list-checks" },
  { key: "look", label: "ページの見た目", icon: "layout-template" },
  { key: "after", label: "送信後・完了後", icon: "arrow-right" },
  { key: "confirm", label: "確認メール", icon: "mail" },
  { key: "embed", label: "URL・タグ", icon: "code" },
];
import type { AdminOptions } from "./index.js";

interface SequenceRow {
  id: string;
  topic_id: string | null;
  slug: string;
  name: string;
  status: string;
  allow_reentry: boolean;
  purpose: string;
  done_tag: string | null;
  footer_id: string | null;
  from_name: string | null;
  from_address: string | null;
  reply_to: string | null;
}

interface StepRow {
  id: string;
  position: number;
  delay_days: number;
  send_time: string | null;
  delay_minutes: number | null;
  condition: StepCondition | null;
  subject: string | null;
  body_markdown: string;
  body_format: BodyFormat;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** 識別名が空なら自動で作る（日本語の名前でも作れるように） */
function slugOrAuto(v: string, prefix: string): string {
  return v || `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** フォームの受付を切り替えるボタン */
function formToggle(id: string, active: boolean, backTo: string): string {
  return `<form method="post" action="/admin/forms/${h(id)}/active" class="inline"><input type="hidden" name="back" value="${h(backTo)}"><input type="hidden" name="active" value="${active ? "0" : "1"}">
<button type="submit" class="${active ? "sub" : ""}">${icon(active ? "power-off" : "power", 16)}${active ? "受付を止める" : "受付を始める"}</button></form>`;
}

async function ensureTag(ctx: AppContext, name: string, kind?: string): Promise<string> {
  const prefix = name.split(":")[0] ?? "";
  // kind を渡せば名前に接頭辞を付けずに種類を決められる（登録元のタグなど。画面には名前だけを出す）
  const category = kind ?? (["src", "int", "seq", "cust", "ch"].includes(prefix) ? prefix : "other");
  const [t] = await ctx.db.query<{ id: string }>(
    "INSERT INTO tags (name, category) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [name, category],
  );
  return t!.id;
}

function conditionFromForm(f: Form): StepCondition | null {
  const c: StepCondition = {};
  const min = one(f, "minScore");
  if (min !== "" && Number.isFinite(Number(min))) c.minScore = Number(min);
  const tiers = many(f, "tiers").filter((t): t is Tier => TIERS.some(([k]) => k === t));
  if (tiers.length) c.tiers = tiers;
  const has = tagsFrom(f, "hasTags");
  if (has.length) c.hasTags = has;
  const lacks = tagsFrom(f, "lacksTags");
  if (lacks.length) c.lacksTags = lacks;
  return Object.keys(c).length ? c : null;
}

function describeCondition(c: StepCondition | null): string {
  if (!c) return "全員";
  const p: string[] = [];
  if (c.minScore !== undefined) p.push(`スコア ${c.minScore} 以上`);
  if (c.maxScore !== undefined) p.push(`スコア ${c.maxScore} 以下`);
  if (c.tiers) p.push(`区分 ${c.tiers.map((t) => TIERS.find(([k]) => k === t)?.[1] ?? t).join("・")}`);
  if (c.hasTags) p.push(`タグ ${c.hasTags.join("・")} あり`);
  if (c.lacksTags) p.push(`タグ ${c.lacksTags.join("・")} なし`);
  return p.join("、");
}

/** 送るタイミングの 3 つの型（すぐ／○分・○時間後／○日後の○時） */
function timingFields(s: Partial<StepRow>, first: boolean): string {
  const mins = s.delay_minutes;
  const mode = mins !== null && mins !== undefined ? (mins === 0 ? "now" : "after") : (s.delay_days ?? 0) === 0 && !s.send_time ? "now" : "days";
  const inHours = mins !== null && mins !== undefined && mins > 0 && mins % 60 === 0;
  const afterValue = mins && mins > 0 ? (inHours ? mins / 60 : mins) : 1;
  const base = first ? "登録" : "前の通";
  const radio = (v: string) => `<input type="radio" name="timing" value="${v}"${mode === v ? " checked" : ""}>`;
  return `<h2 style="margin-top:0">送るタイミング</h2>
<div class="timing">
<label class="check">${radio("now")}<span><b>すぐ送る</b>（${base}の直後）</span></label>
<label class="check">${radio("after")}<span>${base}から</span><input class="inline-num" type="number" name="after_value" min="1" max="10000" value="${h(afterValue)}" aria-label="何分・何時間後">
<select class="inline-sel" name="after_unit" aria-label="単位"><option value="minutes"${inHours ? "" : " selected"}>分</option><option value="hours"${inHours ? " selected" : ""}>時間</option></select><span>後に送る</span></label>
<label class="check">${radio("days")}<span>${base}から</span><input class="inline-num" type="number" name="delay_days" min="0" max="365" value="${h(mode === "days" ? (s.delay_days ?? 1) : 1)}" aria-label="何日後">
<span>日後の</span><input class="inline-time" type="time" name="send_time" value="${h(s.send_time?.slice(0, 5) ?? "")}" aria-label="時刻"><span>に送る</span></label>
</div>
<p class="muted">時刻は日本時間。「○日後」で時刻が空なら、${base}と同じ時刻に送ります。0 日後で時刻を指定すると、その日のその時刻（過ぎていれば翌日）です。</p>`;
}

/** 登録から数えたおおよその時期（一覧の目安） */
function cumulative(steps: { delay_days: number; send_time: string | null; delay_minutes: number | null }[]): string[] {
  let total = 0;
  return steps.map((st) => {
    total += st.delay_minutes !== null && st.delay_minutes !== undefined ? st.delay_minutes : st.delay_days * 1440;
    if (total === 0) return "登録直後";
    if (total < 60) return `約 ${total} 分後`;
    if (total < 1440) return `約 ${Math.round(total / 60)} 時間後`;
    return `約 ${Math.round(total / 1440)} 日後`;
  });
}

function stepEditor(seqId: string, s: Partial<StepRow>, first: boolean, tags: { name: string; count: number }[]): string {
  const c = s.condition ?? null;
  const action = s.id ? `/admin/sequences/${h(seqId)}/steps/${h(s.id)}` : `/admin/sequences/${h(seqId)}/steps`;
  return `<form method="post" action="${action}" class="card">
${timingFields(s, first)}
<h2>メールの内容</h2>
<label>件名</label><input type="text" name="subject" value="${h(s.subject)}" required maxlength="200">
<div class="row"><div><label>本文の形式（Markdown は自動でレイアウト、HTML は書いたまま送る）</label><select name="format"><option value="markdown"${s.body_format !== "html" ? " selected" : ""}>Markdown</option><option value="html"${s.body_format === "html" ? " selected" : ""}>HTML</option></select></div></div>
<label>本文</label><textarea name="body" required>${h(s.body_markdown)}</textarea>
<details class="acc"${c ? " open" : ""}><summary>送る相手を絞る（任意。合わない人はこの通を飛ばして次の通へ進む）</summary><div class="acc-body">
<label>このタグを<b>すべて</b>持つ人だけ</label>
${tagPicker({ name: "hasTags", tags, selected: c?.hasTags ?? [] })}
<label>このタグを持つ人は飛ばす</label>
${tagPicker({ name: "lacksTags", tags, selected: c?.lacksTags ?? [] })}
<div class="row"><div><label>スコアの下限</label><input type="number" name="minScore" value="${h(c?.minScore)}"></div></div>
<label>区分（チェックが無ければ全員）</label><div class="checks">${TIERS.map(
    ([k, l]) => `<label class="check"><input type="checkbox" name="tiers" value="${k}"${c?.tiers?.includes(k as Tier) ? " checked" : ""}>${l}</label>`,
  ).join("")}</div></div></details>
<div class="actions"><button type="submit">保存する</button></div></form>`;
}

/** シナリオと対になる登録フォームを作る（受付は止めた状態。内容を整えてから始める） */
async function createPairedForm(ctx: AppContext, sequenceId: string, slug: string, name: string): Promise<string | undefined> {
  // 登録元のタグは、読みやすいようにシナリオ名そのもので作る（接頭辞は付けない）
  const tagId = await ensureTag(ctx, name, "src");
  const [f] = await ctx.db.query<{ id: string }>(
    `INSERT INTO forms (slug, name, tag_id, sequence_id, consent_text_version, active, page_title, double_optin)
     VALUES ($1, $2, $3, $4, 'v1', false, $2, false) ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [slug, name, tagId, sequenceId],
  );
  if (f) await audit(ctx.db, "form.create", f.id, { sequenceId });
  return f?.id;
}

/** シナリオの流れ（入口 → 各通 → 完了とその後）。各通から編集・削除できる */
function flowDiagram(o: {
  seqId: string;
  forms: { id: string; name: string; active: boolean }[];
  entryRules: [string, string][];
  steps: (StepRow & { sent: number; clicked: number })[];
  doneTag: string | null;
  exitRules: [string, string][];
}): string {
  const entries = [
    ...o.forms.map(
      (f) => `<a class="flow-chip" href="/admin/forms/${h(f.id)}">${icon("file-input", 14)}フォーム「${h(f.name)}」で登録 ${f.active ? '<span class="pill good">受付中</span>' : '<span class="pill">停止</span>'}</a>`,
    ),
    ...o.entryRules.map(([when]) => `<a class="flow-chip" href="/admin/automations">${icon("zap", 14)}${h(when)}</a>`),
  ];
  const arrow = `<div class="flow-arrow">${icon("arrow-down", 18)}</div>`;
  const approx = cumulative(o.steps);
  const steps = o.steps.map((st, i) => {
    const cond = st.condition ? `<div class="flow-cond">${icon("split", 14)}${h(describeCondition(st.condition))}の人だけ（それ以外は飛ばして次へ）</div>` : "";
    const editUrl = `/admin/sequences/${h(o.seqId)}/steps/${h(st.id)}`;
    return `${arrow}<div class="flow-time">${icon("clock", 14)}${h(describeTiming(st, i === 0))}<span class="muted">（${h(approx[i] ?? "")}）</span></div>
<div class="flow-node"><span class="flow-num">${i + 1}</span><div class="flow-body"><a href="${editUrl}"><b>${h(st.subject || "（件名なし）")}</b></a>${st.body_format === "html" ? ' <span class="pill">HTML</span>' : ""}${cond}
<small>送信 ${st.sent}・クリック率 ${pct(st.clicked, st.sent)}</small></div>
<div class="flow-actions"><a class="btn sub" href="${editUrl}" title="編集">${icon("pencil", 14)}編集</a>
<form method="post" action="${editUrl}/delete" onsubmit="return confirm('${i + 1} 通目「${h(st.subject || "")}」を削除しますか？')"><button class="sub icon-only" type="submit" title="削除" aria-label="削除">${icon("trash", 14)}</button></form></div></div>`;
  });
  const exits = [
    ...(o.doneTag ? [`<span class="flow-chip">${icon("tag", 14)}タグ「${h(o.doneTag)}」を付ける</span>`] : []),
    ...o.exitRules.map(([when, then]) => `<a class="flow-chip" href="/admin/automations">${icon("zap", 14)}${h(when.replace(/^タグ「.*」が付いたとき$/, "そのタグで"))} → ${h(then)}</a>`),
  ];
  return `<div class="flow">
<div class="flow-end">${icon("log-in", 16)}<b>始まり</b><div class="flow-chips">${entries.join("") || '<span class="muted">まだ入口がありません（「登録フォーム」か自動化のルールで始まります）</span>'}</div></div>
${steps.join("") || `${arrow}<div class="muted">まだ通がありません。下の「ステップを追加」から 1 通目を作ります。</div>`}
${arrow}<a class="flow-add" href="#add-step" data-open="add-step">${icon("plus", 16)}ステップを追加</a>
${arrow}<div class="flow-end">${icon("flag", 16)}<b>完了</b><div class="flow-chips">${exits.join("") || '<span class="muted">完了したあとの動きはありません（「基本設定」の完了タグや、自動化のルールで次につなげられます）</span>'}</div></div>
</div>`;
}

export function registerContent(app: Hono, getCtx: () => Promise<AppContext>, _opts: AdminOptions): void {
  // ---- シナリオ ----
  app.get("/sequences", async (c) => {
    const ctx = await getCtx();
    const rows = await ctx.db.query<SequenceRow & { steps: number; active: number; completed: number }>(
      `SELECT s.id, s.slug, s.name, s.status, s.purpose,
              (SELECT count(*) FROM sequence_steps st WHERE st.sequence_id = s.id)::int AS steps,
              (SELECT count(*) FROM enrollments e WHERE e.sequence_id = s.id AND e.status = 'active')::int AS active,
              (SELECT count(*) FROM enrollments e WHERE e.sequence_id = s.id AND e.status = 'completed')::int AS completed
         FROM sequences s ORDER BY s.created_at`,
    );
    const createCard = `<details class="card add-step" id="new-seq"${rows.length ? "" : " open"}><summary>${icon("plus", 16)}新しいシナリオを作る</summary>
<form method="post" action="/admin/sequences">
<p class="muted" style="margin:0">シナリオを作ると、登録フォームも一緒にできます（フォームから登録した人に、このシナリオが届きます）。作ったあと、1 通目から追加していきます。</p><div class="row">
<div><label>名前（例：SEO チェックリスト特典）</label><input type="text" name="name" required maxlength="80"></div>
<div><label>識別名（任意。フォームの URL になります。英小文字・数字・ハイフン。空なら自動）</label><input type="text" name="slug" pattern="[a-z0-9][a-z0-9-]{1,40}"></div></div>
<div class="actions"><button type="submit">${icon("plus", 16)}シナリオとフォームを作る</button></div></form></details>`;
    const body = `${pageHeader({
      title: "シナリオ",
      desc: "登録やタグをきっかけに、決めた順番・間隔で自動で届くステップメールです。",
      actions: `<a class="btn" href="#new-seq" data-open="new-seq">${icon("plus", 16)}新しいシナリオ</a>`,
    })}
${createCard}
${rows.length ? "" : emptyState({ icon: "workflow", title: "まだシナリオがありません", text: "上で名前を決めて作り、1 通目から追加していきます。" })}
${rows.length ? `<div class="wrap"><table><tr><th>名前</th><th>状態</th><th>種類</th><th>通数</th><th>進行中</th><th>完了</th></tr>
${rows
  .map(
    (r) => `<tr><td><a href="/admin/sequences/${h(r.id)}">${h(r.name)}</a><div class="muted">${h(r.slug)}</div></td><td>${statusPill(r.status)}</td>
<td>${r.purpose === "reengage" ? "休眠者の再確認" : "通常"}</td><td>${r.steps}</td><td>${r.active}</td><td>${r.completed}</td></tr>`,
  )
  .join("")}</table></div>` : ""}
<script>document.querySelectorAll('[data-open]').forEach(function(a){a.addEventListener('click',function(e){var d=document.getElementById(a.dataset.open);if(d){e.preventDefault();d.open=true;d.scrollIntoView({behavior:'smooth',block:'start'});var i=d.querySelector('input[name=name]');if(i)i.focus()}})});</script>`;
    return c.html(adminPage({ title: "シナリオ", active: "/admin/sequences", body, flash: flashFrom(c) }));
  });

  app.post("/sequences", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const slug = slugOrAuto(one(f, "slug"), "s");
    if (!SLUG.test(slug)) return back(c, "/admin/sequences", "err", "識別名は英小文字・数字・ハイフンで 2〜41 文字にしてください");
    const name = one(f, "name") || slug;
    const rows = await ctx.db.query<{ id: string }>(
      "INSERT INTO sequences (slug, name, status) VALUES ($1, $2, 'draft') ON CONFLICT (slug) DO NOTHING RETURNING id",
      [slug, name],
    );
    if (!rows[0]) return back(c, "/admin/sequences", "err", "同じ識別名のシナリオがあります");
    await audit(ctx.db, "sequence.create", rows[0].id);
    const formId = await createPairedForm(ctx, rows[0].id, slug, name);
    return back(
      c,
      `/admin/sequences/${rows[0].id}`,
      "ok",
      formId ? "シナリオと登録フォームを作りました。1 通目から追加してください" : "シナリオを作りました（同じ識別名のフォームがあったため、フォームは作っていません）",
    );
  });

  app.get("/sequences/:id", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const [s] = await ctx.db.query<SequenceRow>(
      "SELECT s.*, t.name AS done_tag FROM sequences s LEFT JOIN tags t ON t.id = s.done_tag_id WHERE s.id::text = $1",
      [id],
    );
    if (!s) return c.html(adminPage({ title: "シナリオ", active: "/admin/sequences", body: `${emptyState({ icon: "circle-x", title: "見つかりません", text: "削除されたか、URL が間違っている可能性があります。" })}` }), 404);
    const steps = await ctx.db.query<StepRow & { sent: number; clicked: number }>(
      `SELECT st.id, st.position, st.delay_days, st.send_time::text AS send_time, st.delay_minutes, st.condition, st.subject, st.body_format,
              (SELECT count(*) FROM messages m WHERE m.step_id = st.id AND m.sent_at IS NOT NULL)::int AS sent,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages m ON m.id = e.message_id
                WHERE m.step_id = st.id AND e.type = 'click' AND e.bot_reason IS NULL)::int AS clicked
         FROM sequence_steps st WHERE st.sequence_id = $1 ORDER BY st.position`,
      [s.id],
    );
    const forms = await ctx.db.query<{ id: string; name: string; slug: string; active: boolean; signups: number }>(
      `SELECT f.id, f.name, f.slug, f.active, (SELECT count(*) FROM consents co WHERE co.form_id = f.id)::int AS signups
         FROM forms f WHERE f.sequence_id = $1 ORDER BY f.created_at`,
      [s.id],
    );
    const [enr] = await ctx.db.query<{ active: number; completed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM enrollments WHERE sequence_id = $1`,
      [s.id],
    );
    const topics = await listTopics(ctx.db);
    const tags = await tagsWithCounts(ctx);
    const footers = await listFooters(ctx.db);
    const here = `/admin/sequences/${s.id}`;
    const tab = SEQ_TABS.some((t) => t.key === c.req.query("tab")) ? c.req.query("tab")! : "steps";
    const formCards = forms.length
      ? forms
          .map((fm) => {
            const formUrl = url(ctx, `/f/${fm.slug}`);
            return `<div class="pair"><div><b>${h(fm.name)}</b> ${fm.active ? '<span class="pill good">受付中</span>' : '<span class="pill">停止</span>'} <span class="muted">登録 ${fm.signups}</span>
<div class="muted"><a href="${h(formUrl)}" target="_blank" rel="noopener">${h(formUrl)}</a></div></div>
<div class="actions" style="margin:0">${formToggle(fm.id, fm.active, `${here}?tab=forms`)}${linkButton(`/admin/forms/${fm.id}`, "フォームを編集", "file-input", true)}</div></div>`;
          })
          .join("")
      : `<p class="muted" style="margin:0 0 8px">このシナリオを始めるフォームがありません。</p><form method="post" action="/admin/sequences/${h(s.id)}/form" class="inline"><button type="submit">${icon("plus", 16)}登録フォームを作る</button></form>`;
    const rules = await ctx.db.query<Rule>("SELECT * FROM automation_rules WHERE active");
    const names = await ruleNames(ctx);
    const flow = flowDiagram({
      seqId: s.id,
      forms,
      entryRules: rules.filter((r) => r.action_type === "start_sequence" && r.action_value === s.id).map((r) => describeRule(r, names)),
      steps,
      doneTag: s.done_tag,
      exitRules: rules
        .filter((r) => (r.trigger_type === "sequence_completed" && r.trigger_value === s.id) || (r.trigger_type === "tag_added" && s.done_tag && r.trigger_value === s.done_tag))
        .map((r) => describeRule(r, names)),
    });

    // 状態のバー：いま届くかどうかと、ワンクリックで始める／止めるボタン
    const active = s.status === "active";
    const statusText = active
      ? `<span class="pill good">配信中</span> 登録した人に、上から順に届きます。進行中 ${enr?.active ?? 0} 人・完了 ${enr?.completed ?? 0} 人`
      : s.status === "archived"
        ? '<span class="pill">アーカイブ</span> 新しく登録した人には届きません。'
        : `<span class="pill">下書き</span> まだ誰にも届きません。内容を整えたら「配信を始める」を押してください。`;
    const warn =
      !active && forms.some((fm) => fm.active)
        ? `<br><span class="muted">${icon("triangle-exclamation-point", 14)} フォームは受付中ですが、シナリオが配信中でないため、登録してもステップメールは届きません。</span>`
        : active && steps.length === 0
          ? `<br><span class="muted">${icon("triangle-exclamation-point", 14)} まだ通がありません。「ステップを追加」から 1 通目を作ってください。</span>`
          : "";
    const toggle = `<form method="post" action="/admin/sequences/${h(s.id)}/status" class="inline"><input type="hidden" name="status" value="${active ? "draft" : "active"}">
<button type="submit" class="${active ? "sub" : ""}"${!active && steps.length === 0 ? " disabled title=\"先に 1 通目を作ってください\"" : ""}>${icon(active ? "pause" : "send", 16)}${active ? "配信を止める（下書きに戻す）" : "配信を始める"}</button></form>`;

    const nav = SEQ_TABS.map(
      (t) => `<a href="?tab=${t.key}" data-tab="${t.key}"${t.key === tab ? ' aria-current="page"' : ""}>${icon(t.icon, 16)}${t.label}${t.key === "steps" ? ` <span class="count">${steps.length}</span>` : t.key === "forms" ? ` <span class="count">${forms.length}</span>` : ""}</a>`,
    ).join("");
    const panel = (key: string, inner: string, extraClass = "") => `<section class="card ftab${extraClass}" data-tab="${key}"${key === tab ? "" : " hidden"}>${inner}</section>`;
    const newStepDefaults = steps.length
      ? { delay_days: 1, send_time: "08:00", delay_minutes: null, body_format: "markdown" as const }
      : { delay_days: 0, send_time: null, delay_minutes: 0, body_format: "markdown" as const };

    const stepsPanel = `<div class="ftab" data-tab="steps"${tab === "steps" ? "" : " hidden"}>
<section class="card"><h2 class="with-icon" style="margin-top:0">${icon("workflow", 16)}流れ</h2>
<p class="muted" style="margin:0 0 12px">登録した人に、上から順に届きます。件名か「編集」を押すと、その通の本文・タイミング・送る相手を変えられます。</p>${flow}</section>
<details class="card add-step" id="add-step"${steps.length === 0 ? " open" : ""}><summary>${icon("plus", 16)}ステップを追加 <span class="muted">（${steps.length + 1} 通目として最後に追加されます）</span></summary>
${stepEditor(s.id, newStepDefaults, steps.length === 0, tags).replace('<form method="post"', '<form method="post" data-plain="1"').replace(' class="card">', ">")}</details></div>`;

    const days = PERIODS.some(([d]) => d === Number(c.req.query("days"))) ? Number(c.req.query("days")) : 30;
    const analyticsSection = `<div class="ftab" data-tab="analytics"${tab === "analytics" ? "" : " hidden"}>${analyticsPanel(
      await sequenceAnalytics(ctx, s.id, periodStart(ctx, days)),
      days,
      s.id,
    )}</div>`;

    const formsPanel = panel(
      "forms",
      `<h2 class="with-icon" style="margin-top:0">${icon("file-input", 16)}登録フォーム</h2>
<p class="muted" style="margin:0 0 12px">このフォームから登録した人に、このシナリオが届きます。他のページに貼るタグや入力項目は「フォームを編集」から設定します。</p>${formCards}`,
    );

    const settingsPanel = panel(
      "settings",
      `<h2 style="margin-top:0">基本設定</h2><div class="row">
<div><label>名前</label><input type="text" name="name" value="${h(s.name)}" required></div>
<div><label>状態</label><select name="status">${["draft", "active", "archived"].map((v) => `<option value="${v}"${s.status === v ? " selected" : ""}>${statusPill(v).replace(/<[^>]+>/g, "")}</option>`).join("")}</select></div></div>
<div class="row"><div><label>最後まで届いたら付けるタグ（任意。次のシナリオや自動化につなげるときに使う）</label><input type="text" name="done_tag" value="${h(s.done_tag)}" placeholder="例：${h(s.name)}完了" list="tag-list">
<datalist id="tag-list">${tags.map((t) => `<option value="${h(t.name)}"></option>`).join("")}</datalist></div>
<div>${footerSelect(footers, s.footer_id)}</div></div>
<label>配信の種類（読者が「受け取らない」を選んでいたら、このシナリオは届かない）</label>
${topicPicker({ topics, current: s.topic_id })}
<div class="checks"><label class="check"><input type="checkbox" name="allow_reentry" value="1"${s.allow_reentry ? " checked" : ""}>完了した人も、もう一度登録したら最初から送る</label>
<label class="check"><input type="checkbox" name="reengage" value="1"${s.purpose === "reengage" ? " checked" : ""}>休眠者の再確認シナリオとして使う</label></div>`,
    );
    const senderPanel = panel(
      "sender",
      `<h2 style="margin-top:0">送信者</h2>
<p class="muted" style="margin:0">このシナリオのメールと、このシナリオを始めるフォームの確認メールに使います。</p>
${senderFieldsHtml(ctx, s, true)}`,
    );

    const body = `${pageHeader({ title: s.name, badge: ` ${statusPill(s.status)}`, back: ["/admin/sequences", "シナリオ"] })}
<section class="card status-bar"><div>${statusText}${warn}</div>${s.status === "archived" ? "" : toggle}</section>
<div class="fedit"><nav class="fnav" aria-label="シナリオの設定">${nav}</nav>
<div>${stepsPanel}${analyticsSection}${formsPanel}
<form method="post" action="/admin/sequences/${h(s.id)}" id="seq-settings"><input type="hidden" name="tab" value="${h(tab)}" id="tab-input">
${settingsPanel}${senderPanel}
<div class="fsave"${tab === "settings" || tab === "sender" ? "" : " hidden"}><button type="submit">保存する</button> <span class="muted">「基本設定」と「送信者」をまとめて保存します。</span></div>
</form></div></div>
<script>(function(){
var nav=document.querySelectorAll('.fnav a'),tabs=document.querySelectorAll('.ftab'),save=document.querySelector('.fsave'),ti=document.getElementById('tab-input');
function show(k){tabs.forEach(function(s){s.hidden=s.dataset.tab!==k});nav.forEach(function(a){if(a.dataset.tab===k)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});save.hidden=!(k==='settings'||k==='sender');ti.value=k;var u=new URL(location.href);u.searchParams.set('tab',k);history.replaceState(null,'',u.pathname+u.search+u.hash)}
nav.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();show(a.dataset.tab)})});
document.querySelectorAll('[data-open]').forEach(function(a){a.addEventListener('click',function(){var d=document.getElementById(a.dataset.open);if(d){d.open=true;setTimeout(function(){d.scrollIntoView({behavior:'smooth',block:'start'})},0)}})});
})();</script>`;
    return c.html(adminPage({ title: "シナリオ", active: "/admin/sequences", body, flash: flashFrom(c) }));
  });

  app.post("/sequences/:id/status", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const status = one(await readForm(c), "status") === "active" ? "active" : "draft";
    if (status === "active") {
      const [n] = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM sequence_steps WHERE sequence_id::text = $1", [id]);
      if (!n?.n) return back(c, `/admin/sequences/${id}`, "err", "先に 1 通目を作ってください");
    }
    const rows = await ctx.db.query("UPDATE sequences SET status = $2, updated_at = now() WHERE id::text = $1 AND status <> 'archived' RETURNING id", [id, status]);
    if (rows.length === 0) return back(c, `/admin/sequences/${id}`, "err", "シナリオが見つからないか、アーカイブ済みです");
    await audit(ctx.db, "sequence.update", id, { status });
    return back(c, `/admin/sequences/${id}`, "ok", status === "active" ? "配信を始めました。登録した人に届き始めます" : "配信を止めました（下書きに戻しました）");
  });

  app.post("/sequences/:id", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const f = await readForm(c);
    const status = ["draft", "active", "archived"].includes(one(f, "status")) ? one(f, "status") : "draft";
    const done = one(f, "done_tag");
    const reengage = one(f, "reengage") === "1";
    const sender = readSenderFields(ctx, f);
    if ("error" in sender) return back(c, `/admin/sequences/${id}?tab=sender`, "err", sender.error);
    await ctx.db.query(
      `UPDATE sequences SET name = $2, status = $3, done_tag_id = $4, allow_reentry = $5, purpose = $6, topic_id = $7, footer_id = $8,
              from_name = $9, from_address = $10, reply_to = $11, updated_at = now() WHERE id::text = $1`,
      [
        id,
        one(f, "name"),
        status,
        done ? await ensureTag(ctx, done) : null,
        reengage || one(f, "allow_reentry") === "1",
        reengage ? "reengage" : "normal",
        one(f, "topic_id") && (await ctx.db.query("SELECT 1 FROM topics WHERE id::text = $1", [one(f, "topic_id")])).length ? one(f, "topic_id") : null,
        one(f, "footer_id") && (await ctx.db.query("SELECT 1 FROM footers WHERE id::text = $1", [one(f, "footer_id")])).length ? one(f, "footer_id") : null,
        sender.value.fromName,
        sender.value.fromAddress,
        sender.value.replyTo,
      ],
    );
    await audit(ctx.db, "sequence.update", id, { status });
    const tab = SEQ_TABS.some((t) => t.key === one(f, "tab")) ? one(f, "tab") : "settings";
    return back(c, `/admin/sequences/${id}?tab=${tab}`, "ok", "保存しました");
  });

  app.post("/sequences/:id/form", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const [s] = await ctx.db.query<{ slug: string; name: string }>("SELECT slug, name FROM sequences WHERE id::text = $1", [id]);
    if (!s) return c.text("not found", 404);
    const formId = (await createPairedForm(ctx, id, s.slug, s.name)) ?? (await createPairedForm(ctx, id, slugOrAuto("", "f"), s.name));
    return back(c, `/admin/sequences/${id}`, formId ? "ok" : "err", formId ? "登録フォームを作りました" : "フォームを作れませんでした");
  });

  const saveStep = async (ctx: AppContext, seqId: string, f: Form, stepId?: string): Promise<string | undefined> => {
    const subject = one(f, "subject");
    const body = typeof f.body === "string" ? f.body : one(f, "body");
    const timing = one(f, "timing") || "days";
    const sendTime = timing === "days" ? one(f, "send_time").slice(0, 5) : "";
    if (sendTime && !/^[0-2]\d:[0-5]\d$/.test(sendTime)) return "時刻は 08:00 の形で入力してください";
    let delayMinutes: number | null = null;
    let delayDays = 0;
    if (timing === "now") delayMinutes = 0;
    else if (timing === "after") {
      const v = Math.round(Number(one(f, "after_value")));
      if (!Number.isFinite(v) || v < 1) return "「○分後・○時間後」の数を 1 以上で入れてください";
      delayMinutes = one(f, "after_unit") === "hours" ? v * 60 : v;
    } else {
      delayDays = Math.min(365, Math.max(0, Math.round(Number(one(f, "delay_days")) || 0)));
    }
    try {
      await assertTemplatesValid(ctx, subject, body);
    } catch (e) {
      if (e instanceof TemplateError) return e.message;
      throw e;
    }
    const cond = conditionFromForm(f);
    const values = [delayDays, sendTime || null, cond && JSON.stringify(cond), subject, body, one(f, "format") === "html" ? "html" : "markdown", delayMinutes];
    if (stepId) {
      await ctx.db.query(
        `UPDATE sequence_steps SET delay_days = $3, send_time = $4, condition = $5, subject = $6, body_markdown = $7, body_format = $8, delay_minutes = $9
          WHERE id::text = $2 AND sequence_id::text = $1`,
        [seqId, stepId, ...values],
      );
    } else {
      await ctx.db.query(
        `INSERT INTO sequence_steps (sequence_id, position, delay_days, send_time, condition, subject, body_markdown, body_format, delay_minutes)
         SELECT $1::uuid, COALESCE(max(position), 0) + 1, $2, $3, $4, $5, $6, $7, $8 FROM sequence_steps WHERE sequence_id = $1::uuid`,
        [seqId, ...values],
      );
    }
    return undefined;
  };

  app.post("/sequences/:id/steps", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const err = await saveStep(ctx, id, await readForm(c));
    if (err) return back(c, `/admin/sequences/${id}`, "err", err);
    await audit(ctx.db, "step.create", id);
    return back(c, `/admin/sequences/${id}`, "ok", "ステップを追加しました");
  });

  app.get("/sequences/:id/steps/:stepId", async (c) => {
    const ctx = await getCtx();
    const { id, stepId } = c.req.param();
    const [st] = await ctx.db.query<StepRow & { is_first: boolean }>(
      "SELECT id, position, delay_days, send_time::text AS send_time, delay_minutes, condition, subject, body_markdown, body_format, position = (SELECT min(position) FROM sequence_steps x WHERE x.sequence_id = sequence_steps.sequence_id) AS is_first FROM sequence_steps WHERE id::text = $1 AND sequence_id::text = $2",
      [stepId, id],
    );
    if (!st) return c.html(adminPage({ title: "シナリオ", active: "/admin/sequences", body: `${emptyState({ icon: "circle-x", title: "見つかりません", text: "削除されたか、URL が間違っている可能性があります。" })}` }), 404);
    const [seqFooter] = await ctx.db.query<{ footer_id: string | null }>("SELECT footer_id FROM sequences WHERE id::text = $1", [id]);
    const body = `${pageHeader({ title: `${st.position} 通目`, back: [`/admin/sequences/${id}`, "シナリオに戻る"] })}
${stepEditor(id, st, st.is_first, await tagsWithCounts(ctx))}
<div class="actions"><form method="post" action="/admin/sequences/${h(id)}/steps/${h(st.id)}/test" class="inline"><button class="sub" type="submit">テスト送信（${(ctx.settings.testRecipients ?? []).length} 件の宛先）</button></form></div>
<h2>プレビュー（サンプルの読者「山田」さん宛て）</h2><iframe class="preview" sandbox srcdoc="${h((await renderSample(ctx, st.subject ?? "", st.body_markdown, st.body_format, seqFooter?.footer_id)).html)}"></iframe>`;
    return c.html(adminPage({ title: "シナリオ", active: "/admin/sequences", body, flash: flashFrom(c) }));
  });

  app.post("/sequences/:id/steps/:stepId", async (c) => {
    const ctx = await getCtx();
    const { id, stepId } = c.req.param();
    const err = await saveStep(ctx, id, await readForm(c), stepId);
    const path = `/admin/sequences/${id}/steps/${stepId}`;
    if (err) return back(c, path, "err", err);
    await audit(ctx.db, "step.update", stepId);
    return back(c, path, "ok", "保存しました");
  });

  app.get("/sequences/:id/steps/:stepId/preview", async (c) => {
    const ctx = await getCtx();
    const [st] = await ctx.db.query<StepRow & { footer_id: string | null }>(
      "SELECT st.subject, st.body_markdown, st.body_format, s.footer_id FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id WHERE st.id::text = $1",
      [c.req.param("stepId")],
    );
    if (!st) return c.text("not found", 404);
    return previewResponse(c, (await renderSample(ctx, st.subject ?? "", st.body_markdown, st.body_format, st.footer_id)).html);
  });

  app.post("/sequences/:id/steps/:stepId/test", async (c) => {
    const ctx = await getCtx();
    const { id, stepId } = c.req.param();
    const [st] = await ctx.db.query<StepRow & { footer_id: string | null; fromName: string | null; fromAddress: string | null; replyTo: string | null }>(
      `SELECT st.subject, st.body_markdown, st.body_format, s.footer_id, s.from_name AS "fromName", s.from_address AS "fromAddress", s.reply_to AS "replyTo"
         FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id WHERE st.id::text = $1`,
      [stepId],
    );
    const path = `/admin/sequences/${id}/steps/${stepId}`;
    if (!st) return c.text("not found", 404);
    try {
      const n = await sendTest(ctx, st.subject ?? "", st.body_markdown, st.body_format, st.footer_id, st);
      await audit(ctx.db, "step.test", stepId, { recipients: n });
      return back(c, path, "ok", `テスト送信しました（${n} 件）`);
    } catch (e) {
      return back(c, path, "err", `テスト送信できませんでした：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  app.post("/sequences/:id/steps/:stepId/delete", async (c) => {
    const ctx = await getCtx();
    const { id, stepId } = c.req.param();
    await ctx.db.query("DELETE FROM sequence_steps WHERE id::text = $1 AND sequence_id::text = $2", [stepId, id]);
    await audit(ctx.db, "step.delete", stepId);
    return back(c, `/admin/sequences/${id}`, "ok", "削除しました");
  });

  // ---- フォーム ----
  app.get("/forms", async (c) => {
    const ctx = await getCtx();
    const rows = await ctx.db.query<{ id: string; slug: string; name: string; active: boolean; double_optin: boolean; sequence: string | null; signups: number; confirmed: number }>(
      `SELECT f.id, f.slug, f.name, f.active, f.double_optin, s.name AS sequence,
              (SELECT count(*) FROM consents co WHERE co.form_id = f.id)::int AS signups,
              (SELECT count(*) FROM consents co WHERE co.form_id = f.id AND co.confirmed_at IS NOT NULL)::int AS confirmed
         FROM forms f LEFT JOIN sequences s ON s.id = f.sequence_id ORDER BY f.created_at`,
    );
    const body = `${pageHeader({ title: "フォーム", desc: "キャンペーン・メルマガごとに 1 つ作ります（シナリオを作ると対のフォームが自動でできます）。作ったばかりのフォームは「停止」なので、内容を整えたら「受付を始める」を押してください。" })}
${rows.length ? "" : emptyState({ icon: "file-input", title: "まだフォームがありません", text: "フォームを作ると、登録ページの URL と、他のサイトに貼れるフォームタグが手に入ります。" })}
${rows.length ? `<div class="wrap"><table><tr><th>名前</th><th>受付</th><th>登録の確認</th><th>始めるシナリオ</th><th>登録</th><th>確定</th><th>確定率</th><th></th></tr>
${rows
  .map(
    (r) => `<tr><td><a href="/admin/forms/${h(r.id)}">${h(r.name)}</a><div class="muted">${h(r.slug)}</div></td><td>${r.active ? '<span class="pill good">受付中</span>' : '<span class="pill">停止</span>'}</td>
<td>${r.double_optin ? "ダブル" : "シングル"}</td><td>${h(r.sequence ?? "なし（メルマガのみ）")}</td><td>${r.signups}</td><td>${r.confirmed}</td><td>${pct(r.confirmed, r.signups)}</td><td>${formToggle(r.id, r.active, "/admin/forms")}</td></tr>`,
  )
  .join("")}</table></div>` : ""}
<h2>メルマガだけのフォームを作る</h2><form method="post" action="/admin/forms" class="card"><p class="muted" style="margin:0">ステップメールなしで、メルマガの読者だけを集めるフォームです。特典つきのキャンペーンは「シナリオ」から作ると、フォームも一緒にできます。</p><div class="row">
<div><label>名前</label><input type="text" name="name" required maxlength="80"></div>
<div><label>識別名（任意。URL に使います。英小文字・数字・ハイフン。空なら自動）</label><input type="text" name="slug" pattern="[a-z0-9][a-z0-9-]{1,40}"></div></div>
<div class="actions"><button type="submit">作る</button></div></form>`;
    return c.html(adminPage({ title: "フォーム", active: "/admin/forms", body, flash: flashFrom(c) }));
  });

  app.post("/forms", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const slug = slugOrAuto(one(f, "slug"), "f");
    if (!SLUG.test(slug)) return back(c, "/admin/forms", "err", "識別名は英小文字・数字・ハイフンで 2〜41 文字にしてください");
    const tagId = await ensureTag(ctx, one(f, "name") || slug, "src");
    const rows = await ctx.db.query<{ id: string }>(
      "INSERT INTO forms (slug, name, tag_id, consent_text_version, active, double_optin) VALUES ($1, $2, $3, 'v1', false, false) ON CONFLICT (slug) DO NOTHING RETURNING id",
      [slug, one(f, "name") || slug, tagId],
    );
    if (!rows[0]) return back(c, "/admin/forms", "err", "同じ識別名のフォームがあります");
    await audit(ctx.db, "form.create", rows[0].id);
    return back(c, `/admin/forms/${rows[0].id}`, "ok", "作りました（まだ受付は停止中です）。内容を整えてから「受付を始める」を押してください");
  });

  app.get("/forms/:id", async (c) => {
    const ctx = await getCtx();
    const [f] = await ctx.db.query<{
      id: string;
      slug: string;
      name: string;
      active: boolean;
      sequence_id: string | null;
      tag: string | null;
      lead_magnet_key: string | null;
      page_title: string | null;
      page_description: string | null;
      button_label: string;
      sent_url: string | null;
      sent_message: string | null;
      thanks_url: string | null;
      confirmed_message: string | null;
      privacy_url: string | null;
      allowed_origins: string[];
      confirm_subject: string;
      confirm_body_markdown: string;
      confirm_body_format: BodyFormat;
      consent_text_version: string;
      fields: unknown;
      accept_from: string | null;
      accept_until: string | null;
      double_optin: boolean;
    }>("SELECT f.*, t.name AS tag FROM forms f LEFT JOIN tags t ON t.id = f.tag_id WHERE f.id::text = $1", [c.req.param("id")]);
    if (!f) return c.html(adminPage({ title: "フォーム", active: "/admin/forms", body: `${emptyState({ icon: "circle-x", title: "見つかりません", text: "削除されたか、URL が間違っている可能性があります。" })}` }), 404);
    const seqs = await ctx.db.query<{ id: string; name: string; status: string }>("SELECT id, name, status FROM sequences WHERE purpose = 'normal' ORDER BY created_at");
    const formUrl = url(ctx, `/f/${f.slug}`);
    const fields = normalizeFields(f.fields);
    const tab = FORM_TABS.some((t) => t.key === c.req.query("tab")) ? c.req.query("tab")! : "basic";
    const linked = seqs.find((x) => x.id === f.sequence_id);
    const seqWarn =
      linked && linked.status !== "active"
        ? `<br><span class="muted">${icon("triangle-exclamation-point", 14)} 始めるシナリオ「<a href="/admin/sequences/${h(linked.id)}">${h(linked.name)}</a>」が有効になっていないため、登録してもステップメールは届きません。</span>`
        : "";
    const now = ctx.now();
    const notYet = f.accept_from && new Date(f.accept_from) > now;
    const ended = f.accept_until && new Date(f.accept_until) <= now;
    const windowNote = f.active && (notYet || ended) ? `<br><span class="muted">${icon("calendar-clock", 14)} 受付期間の${notYet ? "前" : "後"}なので、いまはフォームを開くと「受付を終了しました」と表示されます。</span>` : "";
    const field = (name: string, label: string, value: unknown, type = "text", extra = "") =>
      `<div><label>${label}</label><input type="${type}" name="${name}" value="${h(value)}"${extra}></div>`;
    const snippet = embedSnippet({ action: formUrl, buttonLabel: f.button_label, fields });
    const routes = await listRoutes(ctx);
    const routeList = routes.length
      ? routes
          .map(
            (r, i) => `<details class="acc"><summary>${h(r.name)} <code>?r=${h(r.code)}</code></summary><div class="acc-body">
<label>URL</label><div class="copy-row"><input type="text" readonly value="${h(`${formUrl}?r=${r.code}`)}" id="route-url-${i}"><button type="button" class="sub" data-copy="route-url-${i}">${icon("copy", 16)}コピー</button></div>
<label>フォームタグ（この経路として数えます）</label><div class="copy-row top"><textarea readonly id="route-tag-${i}" style="min-height:120px;font-family:var(--font-mono);font-size:12px">${h(embedSnippet({ action: formUrl, buttonLabel: f.button_label, fields, route: r.code }))}</textarea><button type="button" class="sub" data-copy="route-tag-${i}">${icon("copy", 16)}コピー</button></div></div></details>`,
          )
          .join("")
      : `<p class="muted" style="margin:0">まだ経路がありません。<a href="/admin/routes">登録経路</a>で「X プロフィール」などを作ると、ここに経路ごとの URL とタグが出ます。</p>`;
    const preview = formPage({
      action: formUrl,
      title: f.page_title ?? f.name,
      ...(f.page_description ? { description: f.page_description } : {}),
      buttonLabel: f.button_label,
      ...(f.privacy_url ? { privacyUrl: f.privacy_url } : {}),
      fields,
    });
    const nav = FORM_TABS.map(
      (t) => `<a href="?tab=${t.key}" data-tab="${t.key}"${t.key === tab ? ' aria-current="page"' : ""}>${icon(t.icon, 16)}${t.label}</a>`,
    ).join("");
    const panel = (key: string, inner: string) => `<section class="card ftab" data-tab="${key}"${key === tab ? "" : " hidden"}>${inner}</section>`;

    const basic = panel(
      "basic",
      `<h2>基本設定</h2>
<div class="row">${field("name", "名前（管理用）", f.name, "text", " required")}
<div><label>登録後に始めるシナリオ</label><select name="sequence_id"><option value="">なし（メルマガのみ）</option>${seqs.map((s) => `<option value="${h(s.id)}"${f.sequence_id === s.id ? " selected" : ""}>${h(s.name)}</option>`).join("")}</select></div></div>
<div class="row">${field("tag", "登録した人に付けるタグ", f.tag)}${field("lead_magnet_key", "特典ファイル（例 magnets/seo.pdf）", f.lead_magnet_key)}${field("consent_text_version", "同意文言の版", f.consent_text_version, "text", " required")}</div>
<h2>登録の確認</h2>
<div class="optin-choice"><label class="check"><input type="radio" name="double_optin" value="0"${f.double_optin ? "" : " checked"}><span><b>シングルオプトイン</b>：フォームを送信した時点で登録完了（確認メールは送らず、すぐ 1 通目から届く）</span></label>
<label class="check"><input type="radio" name="double_optin" value="1"${f.double_optin ? " checked" : ""}><span><b>ダブルオプトイン</b>：届いた確認メールのリンクを押して登録完了（いたずら登録や打ち間違いを防げる）</span></label></div>
<p class="muted" style="margin:4px 0 0">どちらでも同意の記録（日時・フォーム・同意文言の版）は残ります。シングルオプトインでも、配信停止した人のアドレスで登録されたときだけは、本人確認のため確認メールを送ります。</p>
<h2>受付期間</h2><p class="muted" style="margin:0">空なら期間の制限なし（「受付中」の間はいつでも登録できます）。日本時間で入力します。</p>
<div class="row">${field("accept_from", "受付開始", toJstInput(f.accept_from), "datetime-local")}${field("accept_until", "受付終了", toJstInput(f.accept_until), "datetime-local")}</div>`,
    );

    const typeOptions = (sel: FieldType) => FIELD_TYPES.map((t) => `<option value="${t}"${t === sel ? " selected" : ""}>${FIELD_TYPE_LABELS[t]}</option>`).join("");
    const fieldRow = (x: FormField | undefined) => {
      const t = x?.type ?? "text";
      const isName = x?.key === NAME_FIELD_KEY;
      const extra = x ? (x.options.length ? x.options.join(", ") : x.defaultValue) : "";
      const keyNote = x ? (isName ? "キー name（表示名。%name% で使う）" : `キー ${h(x.key)}（%attr.${h(x.key)}%）`) : "キーは保存時に自動で付きます";
      return `<tr draggable="true"><td class="grip" title="ドラッグで並べ替え">${icon("grip-vertical", 16)}</td>
<td><input type="hidden" name="fk" value="${h(x?.key ?? "")}"><input type="text" name="fl" value="${h(x?.label ?? "")}" placeholder="項目の名前" maxlength="40"><div class="muted">${keyNote}</div></td>
<td><select name="ft">${isName ? `<option value="text"${t === "text" ? " selected" : ""}>テキスト</option><option value="hidden"${t === "hidden" ? " selected" : ""}>非表示</option>` : typeOptions(t)}</select></td>
<td><select name="fr"><option value="0">任意</option><option value="1"${x?.required ? " selected" : ""}>必須</option></select></td>
<td><select name="fe"><option value="1">使う</option><option value="0"${x && !x.enabled ? " selected" : ""}>使わない</option></select></td>
<td><input type="text" name="fx" value="${h(extra)}" placeholder="${["select", "radio", "checkbox"].includes(t) ? "選択肢（カンマ区切り）" : "初期値（空でよい）"}"></td>
<td><button type="button" class="sub row-del" title="この項目を消す（保存で反映）">${icon("trash", 14)}</button></td></tr>`;
    };
    const fieldsPanel = panel(
      "fields",
      `<h2>入力項目</h2>
<p class="muted" style="margin:0 0 12px">上から順にフォームに並びます。左のつまみをドラッグして並べ替えられます。入力された値は読者の属性に保存され、本文やセグメントで %attr.キー% として使えます。</p>
<input type="hidden" name="fields_present" value="1"><div class="wrap"><table class="fields-table"><colgroup><col style="width:32px"><col><col style="width:136px"><col style="width:80px"><col style="width:96px"><col style="width:26%"><col style="width:44px"></colgroup>
<thead><tr><th></th><th>名称</th><th>入力形式</th><th>必須</th><th>フォームで使う</th><th>初期値・選択肢</th><th></th></tr></thead>
<tbody><tr class="fixed"><td>${icon("lock", 16)}</td><td>メールアドレス<div class="muted">固定の項目</div></td><td>メール</td><td>必須</td><td>使う</td><td class="muted">変更できません</td><td></td></tr></tbody>
<tbody id="field-rows">${fields.map((x) => fieldRow(x)).join("")}</tbody></table></div>
<template id="field-row-template">${fieldRow(undefined)}</template>
<div class="actions"><button type="button" class="sub" id="add-field">${icon("plus", 16)}項目を追加</button><span class="muted">入力形式が「非表示」の項目は、初期値がそのまま保存されます（登録経路の記録などに）。</span></div>`,
    );

    const look = panel(
      "look",
      `<h2>ページの見た目</h2>
<div class="row">${field("page_title", "見出し", f.page_title)}${field("button_label", "ボタンの文字", f.button_label, "text", " required")}${field("privacy_url", "プライバシーポリシーの URL", f.privacy_url, "url")}</div>
<label>説明文</label><textarea name="page_description" style="min-height:90px">${h(f.page_description)}</textarea>
<label>埋め込みを許可するサイト（https://ドメイン、カンマ区切り。空なら制限なし）</label><input type="text" name="allowed_origins" value="${h(f.allowed_origins.join(", "))}">`,
    );

    const after = panel(
      "after",
      `<h2>送信後と登録完了後</h2>
${f.double_optin ? "" : `<p class="muted" style="margin:0">シングルオプトインでは、送信するとすぐ下の「登録完了後に移動するページ」へ進みます。</p>`}
<div class="row">${field("sent_url", "確認メールを送った直後に移動するページ（空なら標準ページ）", f.sent_url, "url")}${field("sent_message", "標準ページの文", f.sent_message)}</div>
<div class="row">${field("thanks_url", "登録完了後に移動するページ（空なら標準ページ）", f.thanks_url, "url")}${field("confirmed_message", "標準ページの文", f.confirmed_message)}</div>`,
    );

    const confirmPanel = panel(
      "confirm",
      `<h2>確認メール</h2>
${f.double_optin ? "" : `<p class="flash">${icon("info", 16)}このフォームはシングルオプトインなので、確認メールは通常送りません（配信停止した人が登録し直したときだけ使います）。</p>`}
<div class="row">${field("confirm_subject", "件名", f.confirm_subject, "text", " required")}
<div><label>形式</label><select name="confirm_format"><option value="markdown"${f.confirm_body_format !== "html" ? " selected" : ""}>Markdown</option><option value="html"${f.confirm_body_format === "html" ? " selected" : ""}>HTML</option></select></div></div>
<label>本文（%confirm% が必須）</label><textarea name="confirm_body">${h(f.confirm_body_markdown)}</textarea>`,
    );

    const embedPanel = panel(
      "embed",
      `<h2>設置（URL・タグ）</h2>
<label>フォームのページ</label><div class="copy-row"><input type="text" readonly value="${h(formUrl)}" id="form-url"><button type="button" class="sub" data-copy="form-url">${icon("copy", 16)}コピー</button><a class="btn sub" href="${h(formUrl)}" target="_blank" rel="noopener">${icon("external-link", 16)}開く</a></div>
<label>他のページに貼るフォームタグ（HTML に貼り付け）</label><div class="copy-row top"><textarea readonly id="form-tag" style="min-height:170px;font-family:var(--font-mono);font-size:12px">${h(snippet)}</textarea><button type="button" class="sub" data-copy="form-tag">${icon("copy", 16)}コピー</button></div>
<p class="muted">入力項目を変えたら、貼ってあるタグも貼り直してください。</p>
<h2>登録経路ごとの URL・タグ</h2><p class="muted" style="margin:0 0 4px">どこから登録したかを数えたいときは、場所ごとにこちらを貼ります（<a href="/admin/routes">登録経路</a>で結果を見られます）。</p>
${routeList}
<label>フォームのページのプレビュー（保存した内容）</label><iframe class="preview" sandbox srcdoc="${h(preview)}" style="height:520px"></iframe>`,
    );

    const body = `${pageHeader({ title: f.name, badge: ` ${f.active ? '<span class="pill good">受付中</span>' : '<span class="pill">停止</span>'}`, back: ["/admin/forms", "フォーム"] })}
<style>
.fields-table{min-width:700px;table-layout:fixed}
.fields-table td,.fields-table th{white-space:normal;vertical-align:top;padding:var(--space-2)}
.fields-table input,.fields-table select{height:32px;font-size:13px;padding:0 var(--space-2)}
.fields-table .grip{cursor:grab;color:var(--ink-muted);padding-top:16px}
.fields-table tr.fixed td{color:var(--ink-muted)}
.fields-table tr.dragging{opacity:.5}
.fields-table td button{height:32px;padding:0 var(--space-2)}
.copy-row{display:flex;gap:var(--space-2);align-items:center}.copy-row.top{align-items:flex-start}
.copy-row input,.copy-row textarea{flex:1}
</style>
<section class="card status-bar"><div>${f.active ? '<span class="pill good">受付中</span> フォームから登録できます。' : '<span class="pill">停止</span> いまはフォームから登録できません（ページを開くと「受付を終了しました」と表示）。'}${seqWarn}${windowNote}</div>${formToggle(f.id, f.active, `/admin/forms/${f.id}`)}</section>
<div class="fedit"><nav class="fnav" aria-label="フォームの設定">${nav}</nav>
<div><form method="post" action="/admin/forms/${h(f.id)}" id="form-edit">
<input type="hidden" name="active" value="${f.active ? "1" : "0"}"><input type="hidden" name="tab" value="${h(tab)}" id="tab-input">
${basic}${fieldsPanel}${look}${after}${confirmPanel}
<div class="fsave"${tab === "embed" ? " hidden" : ""}><button type="submit">保存する</button> <span class="muted">すべての区分の変更をまとめて保存します。</span></div>
</form>${embedPanel}</div></div>
<script>(function(){
var nav=document.querySelectorAll('.fnav a'),tabs=document.querySelectorAll('.ftab'),save=document.querySelector('.fsave'),ti=document.getElementById('tab-input');
function show(k){tabs.forEach(function(s){s.hidden=s.dataset.tab!==k});nav.forEach(function(a){if(a.dataset.tab===k)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});save.hidden=k==='embed';ti.value=k;var u=new URL(location.href);u.searchParams.set('tab',k);history.replaceState(null,'',u.pathname+u.search)}
nav.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();show(a.dataset.tab)})});
var rows=document.getElementById('field-rows'),tpl=document.getElementById('field-row-template');
function ph(tr){var t=tr.querySelector('[name=ft]').value,x=tr.querySelector('[name=fx]');x.placeholder=(t==='select'||t==='radio'||t==='checkbox')?'選択肢（カンマ区切り）':'初期値（空でよい）'}
rows.addEventListener('change',function(e){if(e.target.name==='ft')ph(e.target.closest('tr'))});
rows.addEventListener('click',function(e){var b=e.target.closest('.row-del');if(b)b.closest('tr').remove()});
document.getElementById('add-field').addEventListener('click',function(){var n=tpl.content.firstElementChild.cloneNode(true);rows.appendChild(n);n.querySelector('[name=fl]').focus()});
var drag=null;rows.addEventListener('dragstart',function(e){if(!e.target.closest||e.target.closest('input,select,button'))return;drag=e.target.closest('tr');drag.classList.add('dragging');e.dataTransfer.effectAllowed='move'});
rows.addEventListener('dragend',function(){if(drag)drag.classList.remove('dragging');drag=null});
rows.addEventListener('dragover',function(e){if(!drag)return;e.preventDefault();var tr=e.target.closest('tr');if(!tr||tr===drag)return;var r=tr.getBoundingClientRect();rows.insertBefore(drag,(e.clientY-r.top)>r.height/2?tr.nextSibling:tr)});
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var el=document.getElementById(b.dataset.copy);el.select();(navigator.clipboard?navigator.clipboard.writeText(el.value):Promise.reject()).catch(function(){document.execCommand('copy')}).finally(function(){var t=b.lastChild.textContent;b.lastChild.textContent='コピーしました';setTimeout(function(){b.lastChild.textContent=t},1500)})})});
})();</script>`;
    return c.html(adminPage({ title: "フォーム", active: "/admin/forms", body, flash: flashFrom(c) }));
  });

  app.post("/forms/:id", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const f = await readForm(c);
    const tab = FORM_TABS.some((t) => t.key === one(f, "tab")) ? one(f, "tab") : "basic";
    const path = `/admin/forms/${id}?tab=${tab}`;
    const httpsOrNull = (k: string): string | null | false => {
      const v = one(f, k);
      if (!v) return null;
      return /^https:\/\//.test(v) ? v : false;
    };
    const urls = { sent_url: httpsOrNull("sent_url"), thanks_url: httpsOrNull("thanks_url"), privacy_url: httpsOrNull("privacy_url") };
    if (Object.values(urls).includes(false)) return back(c, path, "err", "URL は https:// で始めてください");
    const origins = list(one(f, "allowed_origins"));
    if (origins.some((o) => !/^https:\/\/[^/]+$/.test(o))) return back(c, path, "err", "埋め込みを許可するサイトは https://ドメイン の形にしてください");
    const confirmBody = typeof f.confirm_body === "string" ? f.confirm_body : one(f, "confirm_body");
    if (!/%(confirm|登録確認)(\|[^%]*)?%/.test(confirmBody)) return back(c, path, "err", "確認メールの本文に %confirm% を入れてください");
    try {
      await assertTemplatesValid(ctx, one(f, "confirm_subject"), confirmBody);
    } catch (e) {
      if (e instanceof TemplateError) return back(c, path, "err", e.message);
      throw e;
    }
    // 入力項目の表（行ごとに同じ名前の値が並ぶ）
    const col = (k: string) => many(f, k);
    const labels = col("fl");
    const built = buildFields(
      labels.map((label, i) => ({
        key: col("fk")[i] ?? "",
        label,
        type: col("ft")[i] ?? "text",
        required: col("fr")[i] === "1",
        enabled: col("fe")[i] !== "0",
        extra: col("fx")[i] ?? "",
      })),
    );
    if ("error" in built) return back(c, path, "err", built.error);
    const acceptFrom = one(f, "accept_from") ? fromJstInput(one(f, "accept_from")) : null;
    const acceptUntil = one(f, "accept_until") ? fromJstInput(one(f, "accept_until")) : null;
    if (acceptFrom === undefined || acceptUntil === undefined) return back(c, path, "err", "受付期間の日時を確認してください");
    if (acceptFrom && acceptUntil && acceptFrom >= acceptUntil) return back(c, path, "err", "受付終了は受付開始より後にしてください");
    const tag = one(f, "tag");
    await ctx.db.query(
      `UPDATE forms SET name = $2, active = $3, sequence_id = $4, tag_id = $5, lead_magnet_key = $6, consent_text_version = $7,
              page_title = $8, page_description = $9, button_label = $10, privacy_url = $11, allowed_origins = $12,
              sent_url = $13, sent_message = $14, thanks_url = $15, confirmed_message = $16,
              confirm_subject = $17, confirm_body_markdown = $18, confirm_body_format = $19,
              fields = COALESCE($20::jsonb, fields), accept_from = $21, accept_until = $22, double_optin = COALESCE($23, double_optin)
        WHERE id::text = $1`,
      [
        id,
        one(f, "name"),
        one(f, "active") === "1",
        one(f, "sequence_id") || null,
        tag ? await ensureTag(ctx, tag) : null,
        one(f, "lead_magnet_key") || null,
        one(f, "consent_text_version") || "v1",
        one(f, "page_title") || null,
        one(f, "page_description") || null,
        one(f, "button_label") || "登録する",
        urls.privacy_url,
        origins,
        urls.sent_url,
        one(f, "sent_message") || null,
        urls.thanks_url,
        one(f, "confirmed_message") || null,
        one(f, "confirm_subject"),
        confirmBody,
        one(f, "confirm_format") === "html" ? "html" : "markdown",
        one(f, "fields_present") === "1" ? JSON.stringify(built.fields) : null,
        acceptFrom,
        acceptUntil,
        one(f, "double_optin") === "" ? null : one(f, "double_optin") === "1",
      ],
    );
    await audit(ctx.db, "form.update", id, { doubleOptin: one(f, "double_optin") || undefined });
    return back(c, path, "ok", "保存しました");
  });

  app.post("/forms/:id/active", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const f = await readForm(c);
    const active = one(f, "active") === "1";
    const backTo = one(f, "back").startsWith("/admin/") ? one(f, "back") : `/admin/forms/${id}`;
    const [row] = await ctx.db.query<{ sequence_status: string | null }>(
      `UPDATE forms SET active = $2 WHERE id::text = $1
       RETURNING (SELECT status FROM sequences WHERE id = forms.sequence_id) AS sequence_status`,
      [id, active],
    );
    if (!row) return back(c, backTo, "err", "フォームが見つかりません");
    await audit(ctx.db, active ? "form.start" : "form.stop", id);
    const note = active && row.sequence_status && row.sequence_status !== "active" ? "（シナリオがまだ有効ではないため、ステップメールは届きません）" : "";
    return back(c, backTo, "ok", active ? `受付を始めました${note}` : "受付を止めました");
  });
}

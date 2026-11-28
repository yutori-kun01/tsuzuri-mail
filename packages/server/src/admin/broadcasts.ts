import type { BodyFormat, Tier } from "@tsuzuri/core";
import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import type { SegmentRule } from "../segments.js";
import { abStats, assertTemplatesValid, countRecipients, isAbTest, TemplateError } from "../services/broadcasts.js";
import { listTopics, type Topic } from "../services/preferences.js";
import { mailStats } from "../services/reports.js";
import { audit } from "./auth.js";
import { back, flashFrom, many, one, previewResponse, readForm, readSenderFields, renderSample, senderFieldsHtml, sendTest, tagsFrom, tagsWithCounts, type Form } from "./common.js";
import { listFooters, type Footer } from "../services/footers.js";
import { footerSelect } from "./footers.js";
import { icon, type IconName } from "./icons.js";
import { adminPage, emptyState, HTML_PLACEHOLDER_NOTE, fromJstInput, h, jst, linkButton, pageHeader, pct, statusPill, tabs, tagPicker, TIERS, toJstInput, topicPicker } from "./ui.js";

interface BroadcastRow {
  id: string;
  subject: string | null;
  body_markdown: string;
  body_format: BodyFormat;
  important: boolean;
  scheduled_at: Date | null;
  status: string;
  segment_definition: SegmentRule | null;
  topic_id: string | null;
  footer_id: string | null;
  from_name: string | null;
  from_address: string | null;
  reply_to: string | null;
  subject_b: string | null;
  ab_percent: number | null;
  ab_wait_minutes: number | null;
  ab_decide_at: Date | null;
  ab_winner: "a" | "b" | null;
  optimize_send_time: boolean;
  created_at: Date;
}

/** 管理画面の簡易条件（タグ・区分・スコア）→ セグメント */
export interface SimpleSegment {
  hasTags: string[];
  lacksTags: string[];
  tiers: Tier[];
  minScore?: number;
}

export function toSegment(s: SimpleSegment): SegmentRule | null {
  const rules: SegmentRule[] = [
    ...s.hasTags.map((tag): SegmentRule => ({ type: "tag", tag, has: true })),
    ...s.lacksTags.map((tag): SegmentRule => ({ type: "tag", tag, has: false })),
    ...(s.tiers.length ? [{ type: "tier", in: s.tiers } as SegmentRule] : []),
    ...(s.minScore !== undefined ? [{ type: "score", op: ">=", value: s.minScore } as SegmentRule] : []),
  ];
  return rules.length ? { type: "group", op: "and", rules } : null;
}

export function fromSegment(seg: SegmentRule | null): SimpleSegment {
  const out: SimpleSegment = { hasTags: [], lacksTags: [], tiers: [] };
  if (!seg || seg.type !== "group") return out;
  for (const r of seg.rules) {
    if (r.type === "tag") (r.has ? out.hasTags : out.lacksTags).push(r.tag);
    else if (r.type === "tier") out.tiers = r.in;
    else if (r.type === "score" && r.op === ">=") out.minScore = r.value;
  }
  return out;
}

function segmentFromForm(f: Form): SimpleSegment {
  const min = one(f, "minScore");
  const tiers = many(f, "tiers").filter((t): t is Tier => TIERS.some(([k]) => k === t));
  return {
    hasTags: tagsFrom(f, "hasTags"),
    lacksTags: tagsFrom(f, "lacksTags"),
    tiers,
    ...(min !== "" && Number.isFinite(Number(min)) ? { minScore: Number(min) } : {}),
  };
}

function describe(seg: SimpleSegment, important: boolean): string {
  const parts: string[] = [];
  if (seg.hasTags.length) parts.push(`タグ ${seg.hasTags.join("・")} を持つ`);
  if (seg.lacksTags.length) parts.push(`タグ ${seg.lacksTags.join("・")} を持たない`);
  if (seg.tiers.length) parts.push(`区分が ${seg.tiers.map((t) => TIERS.find(([k]) => k === t)?.[1] ?? t).join("・")}`);
  if (seg.minScore !== undefined) parts.push(`スコア ${seg.minScore} 以上`);
  const base = parts.length ? parts.join("、") + "の読者" : "配信中の全読者";
  return `${base}（休眠は常に除外${important ? "。重要号なので低下も含む" : "、低下も除外"}）`;
}


interface EditorOptions {
  topics: Topic[];
  tags: { name: string; count: number }[];
  footers: Footer[];
  ctx: AppContext;
}

async function editorOptions(ctx: AppContext): Promise<EditorOptions> {
  return { topics: await listTopics(ctx.db), tags: await tagsWithCounts(ctx), footers: await listFooters(ctx.db), ctx };
}

function editor(b: Partial<BroadcastRow>, seg: SimpleSegment, count: number | undefined, readonly: boolean, o: EditorOptions): string {
  const dis = readonly ? " disabled" : "";
  const action = b.id ? `/admin/broadcasts/${h(b.id)}` : "/admin/broadcasts";
  const tierChecks = TIERS.filter(([k]) => k !== "dormant")
    .map(([k, l]) => `<label class="check"><input type="checkbox" name="tiers" value="${k}"${seg.tiers.includes(k as Tier) ? " checked" : ""}${dis}>${l}</label>`)
    .join("");
  const usingAb = !!b.subject_b;
  const usingTime = !!b.optimize_send_time;
  const usingSender = !!(b.from_name || b.from_address || b.reply_to);
  const head = (n: number, ic: IconName, title: string, note = "") =>
    `<span class="sect-num">${n}</span>${icon(ic, 16)}<span>${title}</span>${note ? `<span class="sect-note">${note}</span>` : ""}`;
  return `<form method="post" action="${action}" id="bc-form">
<section class="sect"><div class="sect-head">${head(1, "mail", "内容")}</div><div class="sect-body">
<label>件名（置き換え文字が使えます）</label><input type="text" name="subject" value="${h(b.subject)}" required maxlength="200"${dis}>
<div class="row"><div><label>本文の形式</label><select name="format"${dis}>
<option value="markdown"${b.body_format !== "html" ? " selected" : ""}>Markdown（自動でレイアウト）</option>
<option value="html"${b.body_format === "html" ? " selected" : ""}>HTML（書いたまま送る）</option></select></div>
<div>${footerSelect(o.footers, b.footer_id, dis)}</div></div>
<label>本文</label><textarea name="body" required${dis}>${h(b.body_markdown)}</textarea>${HTML_PLACEHOLDER_NOTE}</div></section>

<section class="sect"><div class="sect-head">${head(2, "users", "宛先")}</div><div class="sect-body">
<label>配信の種類（読者が「受け取らない」を選んだ種類は届かない）</label>
${topicPicker({ topics: o.topics, current: b.topic_id, disabled: readonly })}
<label>このタグを<b>すべて</b>持つ人だけに送る（選ばなければ条件なし）</label>
${tagPicker({ name: "hasTags", tags: o.tags, selected: seg.hasTags, disabled: readonly })}
<label>このタグを持つ人には送らない</label>
${tagPicker({ name: "lacksTags", tags: o.tags, selected: seg.lacksTags, disabled: readonly })}
<label class="check"><input type="checkbox" name="important" value="1"${b.important ? " checked" : ""}${dis}>重要号として送る（区分「低下」の読者にも届ける）</label>
<details class="acc"${seg.minScore !== undefined || seg.tiers.length ? " open" : ""}><summary>スコア・区分で絞る（くわしい条件）</summary><div class="acc-body">
<div class="row"><div><label>スコアの下限（任意）</label><input type="number" name="minScore" value="${h(seg.minScore)}" step="1"${dis}></div></div>
<label>区分（チェックが無ければ、休眠以外すべて）</label><div class="checks">${tierChecks}</div></div></details>
${readonly ? `<p class="muted">${h(describe(seg, b.important ?? false))}${count !== undefined ? `：<b>${count} 人</b>` : ""}</p>` : ""}</div></section>

<details class="sect"${usingAb || usingTime ? " open" : ""}><summary class="sect-head">${head(3, "flask-conical", "送り方の工夫", usingAb ? "A/B テストあり" : usingTime ? "送信時刻の最適化あり" : "任意")}</summary><div class="sect-body">
<p class="muted" style="margin:8px 0 0">どちらか 1 つを選べます（同時には使えません）。使わなければ、全員に同じ件名で送信日時に届きます。</p>
<div class="opt-card ab"><div class="opt-title">${icon("split", 16)}件名の A/B テスト</div>
<label for="subject_b">件名 B（入れると A/B テストになります。件名 A は上の「件名」）</label>
<input id="subject_b" type="text" name="subject_b" value="${h(b.subject_b)}" maxlength="200"${dis} placeholder="例：%name%さん、今週のお便りです">
<div class="row"><div><label for="ab_percent">テストに使う人数（A と B に半分ずつ）</label><select id="ab_percent" name="ab_percent"${dis}>${[10, 20, 30, 40, 50]
    .map((p) => `<option value="${p}"${(b.ab_percent ?? 20) === p ? " selected" : ""}>宛先の ${p}%</option>`)
    .join("")}</select></div>
<div><label for="ab_wait">勝ちを決めるまで</label><select id="ab_wait" name="ab_wait_minutes"${dis}>${[
    [60, "1 時間後"],
    [120, "2 時間後"],
    [240, "4 時間後"],
    [480, "8 時間後"],
    [1440, "24 時間後"],
  ]
    .map(([m, l]) => `<option value="${m}"${(b.ab_wait_minutes ?? 240) === m ? " selected" : ""}>${l}</option>`)
    .join("")}</select></div></div>
<p class="opt-note">クリック率が高い件名を勝ちとし、残りの読者に送ります（同じなら開封率、それも同じなら A）。宛先が少ないと偶然の差が出やすいので、目安は 1,000 人以上です。</p></div>
<div class="opt-card time"><div class="opt-title">${icon("clock", 16)}読者ごとの送信時刻</div>
<label class="check"><input type="checkbox" name="optimize_send_time" value="1"${usingTime ? " checked" : ""}${dis}>読者ごとに、よくメールを開いて押す時間帯に合わせて送る</label>
<p class="opt-note">過去のクリックが 3 回以上ある読者は、送信日時から 24 時間以内の「よく押す時刻」に届きます。それ以外の読者は送信日時に届きます。</p></div>
</div></details>

${readonly ? "" : `<details class="sect"${usingSender ? " open" : ""}><summary class="sect-head">${head(4, "send", "送信者", usingSender ? "変更あり" : "設定のまま")}</summary><div class="sect-body">${senderFieldsHtml(o.ctx, b, true)}</div></details>`}
${readonly ? "" : `<div class="fsave"><button type="submit">保存する</button> <span class="muted">保存すると下書きになります。予約は保存のあとで行います。</span></div>`}</form>`;
}

/** 右側のプレビュー（スマホ幅）と宛先人数。入力のたびに htmx で差し替える */
function livePanel(o: { subject: string; html?: string; error?: string; count?: number; description: string }): string {
  const preview = o.error
    ? `<div class="flash error">${icon("circle-x", 16)}${h(o.error)}</div>`
    : `<div class="phone"><div class="phone-bar">${icon("inbox", 14)}<b>${h(o.subject || "（件名なし）")}</b></div><iframe sandbox title="メールのプレビュー" srcdoc="${h(o.html ?? "")}"></iframe></div>`;
  const count =
    o.count !== undefined
      ? `<div class="count-box">${icon("users", 18)}<span>宛先 <b>${o.count}</b> 人</span></div><p class="muted" style="margin:8px 0 0">${h(o.description)}</p>`
      : "";
  return `${preview}${count}`;
}

/** 入力中の内容でプレビューを描く（保存はしない） */
async function liveFromForm(ctx: AppContext, f: Form): Promise<string> {
  const subject = one(f, "subject");
  const bodyText = typeof f.body === "string" ? f.body : one(f, "body");
  const format: BodyFormat = one(f, "format") === "html" ? "html" : "markdown";
  const simple = segmentFromForm(f);
  const important = one(f, "important") === "1";
  const topicRaw = one(f, "topic_id");
  const topicId = topicRaw && (await ctx.db.query("SELECT 1 FROM topics WHERE id::text = $1", [topicRaw])).length ? topicRaw : null;
  const count = await countRecipients(ctx, toSegment(simple), important, topicId);
  const description = describe(simple, important);
  try {
    await assertTemplatesValid(ctx, subject, { text: bodyText, format });
    const r = await renderSample(ctx, subject, bodyText || " ", format, one(f, "footer_id") || null);
    return livePanel({ subject: r.subject, html: r.html, count, description });
  } catch (e) {
    if (e instanceof TemplateError) return livePanel({ subject, error: e.message, count, description });
    throw e;
  }
}

/** 編集画面の右カラム。下書きは入力に合わせて自動更新、それ以外は保存内容を表示 */
function liveSlot(initial: string, editable: boolean): string {
  return editable
    ? `<div id="live" hx-post="/admin/broadcasts/live" hx-include="#bc-form" hx-trigger="input changed delay:700ms from:#bc-form, change from:#bc-form" hx-sync="this:replace">${initial}</div>`
    : `<div id="live">${initial}</div>`;
}

export function registerBroadcasts(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/broadcasts", async (c) => {
    const ctx = await getCtx();
    const raw = c.req.query("status") ?? "";
    const status = ["draft", "scheduled", "sent", "canceled"].includes(raw) ? raw : "";
    const statusIn = status === "scheduled" ? ["scheduled", "sending", "testing"] : status ? [status] : [];
    const rows = await ctx.db.query<{
      id: string;
      subject: string | null;
      status: string;
      scheduled_at: Date | null;
      created_at: Date;
      recipients: number;
      delivered: number;
      bounced: number;
      complained: number;
      opened: number;
      clicked: number;
    }>(
      `SELECT b.id, b.subject, b.status, b.scheduled_at, b.created_at,
              (SELECT count(*) FROM messages m WHERE m.broadcast_id = b.id)::int AS recipients,
              (SELECT count(*) FROM messages m WHERE m.broadcast_id = b.id AND m.status = 'delivered')::int AS delivered,
              (SELECT count(*) FROM messages m WHERE m.broadcast_id = b.id AND m.status = 'bounced')::int AS bounced,
              (SELECT count(*) FROM messages m WHERE m.broadcast_id = b.id AND m.status = 'complained')::int AS complained,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages m ON m.id = e.message_id
                WHERE m.broadcast_id = b.id AND e.type = 'open' AND NOT e.machine)::int AS opened,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages m ON m.id = e.message_id
                WHERE m.broadcast_id = b.id AND e.type = 'click' AND e.bot_reason IS NULL)::int AS clicked
         FROM broadcasts b WHERE (cardinality($1::text[]) = 0 OR b.status = ANY($1::text[])) ORDER BY coalesce(b.scheduled_at, b.created_at) DESC LIMIT 100`,
      [statusIn],
    );
    const byStatus = await ctx.db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM broadcasts GROUP BY status");
    const n = (k: string) => byStatus.find((r) => r.status === k)?.n ?? 0;
    const total = byStatus.reduce((a, r) => a + r.n, 0);
    const tabList = [
      ["", "すべて", total],
      ["draft", "下書き", n("draft")],
      ["scheduled", "予約中・送信中", n("scheduled") + n("sending") + n("testing")],
      ["sent", "送信済み", n("sent")],
      ["canceled", "取り消し", n("canceled")],
    ] as const;
    const table = rows.length
      ? `<div class="wrap"><table><tr><th>件名</th><th>状態</th><th>送信日時</th><th>宛先</th><th>配達</th><th>開封</th><th>クリック</th><th>バウンス</th><th>苦情</th><th></th></tr>
${rows
  .map(
    (r) => `<tr><td><a href="/admin/broadcasts/${h(r.id)}">${h(r.subject || "（件名なし）")}</a></td><td>${statusPill(r.status)}</td>
<td>${h(jst(r.scheduled_at))}</td><td>${r.recipients}</td><td>${pct(r.delivered, r.recipients)}</td><td>${pct(r.opened, r.recipients)}</td>
<td>${pct(r.clicked, r.recipients)}</td><td>${r.bounced}</td><td>${r.complained}</td><td>${r.recipients ? `<a href="/admin/logs/mail/broadcast/${h(r.id)}">レポート</a>` : ""}</td></tr>`,
  )
  .join("")}</table></div>
<p class="muted" style="margin-top:12px">開封率は機械開封（Apple のプライバシー保護など）を除いた目安です。クリック率の方が信頼できます。</p>`
      : total === 0
        ? emptyState({ icon: "send", title: "まだ一斉配信がありません", text: "メルマガ読者全員、またはタグや区分で絞った読者に、1 通のメールを届けます。", action: linkButton("/admin/broadcasts/new", "一斉配信を作る", "plus") })
        : emptyState({ icon: "inbox", title: "この状態の配信はありません", text: "ほかのタブを確認してください。" });
    const body = `${pageHeader({ title: "一斉配信", desc: "メルマガを書いて、確認してから予約します。送信後は配達・クリックの結果がここに並びます。", actions: linkButton("/admin/broadcasts/new", "一斉配信を作る", "plus") })}
${tabs(tabList.map(([k, label, count]) => ({ href: k ? `/admin/broadcasts?status=${k}` : "/admin/broadcasts", label, count, current: status === k })))}
${table}`;
    return c.html(adminPage({ title: "一斉配信", active: "/admin/broadcasts", body, flash: flashFrom(c) }));
  });

  app.get("/broadcasts/new", async (c) => {
    const ctx = await getCtx();
    const seg = { hasTags: [], lacksTags: [], tiers: [] };
    const count = await countRecipients(ctx, null, false);
    const initial = livePanel({ subject: "", html: (await renderSample(ctx, "", "ここに本文のプレビューが表示されます。", "markdown")).html, count, description: describe(seg, false) });
    const body = `${pageHeader({ title: "一斉配信を作る", desc: "入力すると右側のプレビューと宛先人数がその場で変わります。保存すると下書きになります。", back: ["/admin/broadcasts", "一斉配信"] })}
<div class="split"><div>${editor({ body_format: "markdown", important: false }, seg, count, false, await editorOptions(ctx))}</div>
<aside class="sticky">${liveSlot(initial, true)}</aside></div>`;
    return c.html(adminPage({ title: "一斉配信", active: "/admin/broadcasts", body, flash: flashFrom(c) }));
  });

  const save = async (ctx: AppContext, f: Form, id?: string): Promise<{ id?: string; error?: string }> => {
    const subject = one(f, "subject");
    const bodyText = typeof f.body === "string" ? f.body : one(f, "body");
    const format: BodyFormat = one(f, "format") === "html" ? "html" : "markdown";
    if (!subject || !bodyText.trim()) return { error: "件名と本文を入力してください" };
    try {
      await assertTemplatesValid(ctx, subject, { text: bodyText, format });
    } catch (e) {
      if (e instanceof TemplateError) return { error: e.message };
      throw e;
    }
    const seg = toSegment(segmentFromForm(f));
    const important = one(f, "important") === "1";
    const topicRaw = one(f, "topic_id");
    const topicId = topicRaw && (await ctx.db.query("SELECT 1 FROM topics WHERE id::text = $1", [topicRaw])).length ? topicRaw : null;
    const subjectB = one(f, "subject_b").slice(0, 200) || null;
    const optimize = one(f, "optimize_send_time") === "1";
    if (subjectB && optimize) return { error: "件名の A/B テストと、読者ごとの送信時刻は同時に使えません。どちらかにしてください" };
    if (subjectB) {
      try {
        await assertTemplatesValid(ctx, subjectB);
      } catch (e) {
        if (e instanceof TemplateError) return { error: e.message };
        throw e;
      }
    }
    const abPercent = subjectB ? Math.min(50, Math.max(10, Number(one(f, "ab_percent")) || 20)) : null;
    const abWait = subjectB ? Math.min(1440, Math.max(60, Number(one(f, "ab_wait_minutes")) || 240)) : null;
    const footerRaw = one(f, "footer_id");
    const footerId = footerRaw && (await ctx.db.query("SELECT 1 FROM footers WHERE id::text = $1", [footerRaw])).length ? footerRaw : null;
    const sender = readSenderFields(ctx, f);
    if ("error" in sender) return { error: sender.error };
    const { fromName, fromAddress, replyTo } = sender.value;
    if (id) {
      const rows = await ctx.db.query(
        `UPDATE broadcasts SET subject = $2, body_markdown = $3, body_format = $4, important = $5, segment_definition = $6, topic_id = $7, footer_id = $8,
                subject_b = $9, ab_percent = $10, ab_wait_minutes = $11, optimize_send_time = $12,
                from_name = $13, from_address = $14, reply_to = $15, updated_at = now()
          WHERE id::text = $1 AND status = 'draft' RETURNING id`,
        [id, subject, bodyText, format, important, seg && JSON.stringify(seg), topicId, footerId, subjectB, abPercent, abWait, optimize, fromName, fromAddress, replyTo],
      );
      if (rows.length === 0) return { error: "下書き以外は編集できません（予約を取り消してから編集してください）" };
      return { id };
    }
    const [r] = await ctx.db.query<{ id: string }>(
      `INSERT INTO broadcasts (subject, body_markdown, body_format, important, segment_definition, topic_id, footer_id,
                               subject_b, ab_percent, ab_wait_minutes, optimize_send_time, from_name, from_address, reply_to, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft') RETURNING id`,
      [subject, bodyText, format, important, seg && JSON.stringify(seg), topicId, footerId, subjectB, abPercent, abWait, optimize, fromName, fromAddress, replyTo],
    );
    return { id: r!.id };
  };

  app.post("/broadcasts", async (c) => {
    const ctx = await getCtx();
    const r = await save(ctx, await readForm(c));
    if (r.error) return back(c, "/admin/broadcasts/new", "err", r.error);
    await audit(ctx.db, "broadcast.create", r.id);
    return back(c, `/admin/broadcasts/${r.id}`, "ok", "下書きを保存しました。プレビューとテスト送信で確認してから予約してください");
  });

  app.post("/broadcasts/live", async (c) => {
    const ctx = await getCtx();
    return c.html(await liveFromForm(ctx, await readForm(c)));
  });

  app.get("/broadcasts/:id", async (c) => {
    const ctx = await getCtx();
    const [b] = await ctx.db.query<BroadcastRow>("SELECT * FROM broadcasts WHERE id::text = $1", [c.req.param("id")]);
    if (!b) return c.html(adminPage({ title: "一斉配信", active: "/admin/broadcasts", body: `${emptyState({ icon: "circle-x", title: "見つかりません", text: "削除されたか、URL が間違っている可能性があります。" })}` }), 404);
    const seg = fromSegment(b.segment_definition);
    const readonly = b.status !== "draft";
    const count =
      b.status === "draft" || b.status === "scheduled" ? await countRecipients(ctx, b.segment_definition, b.important, b.topic_id) : undefined;
    const minDate = toJstInput(ctx.now());
    const controls =
      b.status === "draft"
        ? `<div class="card"><h2 style="margin-top:0">確認と送信</h2>
<div class="actions"><form method="post" action="/admin/broadcasts/${h(b.id)}/test" class="inline"><button class="sub" type="submit">テスト送信（${(ctx.settings.testRecipients ?? []).length} 件の宛先）</button></form></div>
<form method="post" action="/admin/broadcasts/${h(b.id)}/schedule">
<div class="row"><div><label>送信日時（日本時間。空なら今すぐ）</label><input type="datetime-local" name="at" min="${h(minDate)}"></div></div>
<label class="check"><input type="checkbox" name="confirm" value="1" required>件名・本文・宛先（${count ?? 0} 人）を確認しました</label>
<div class="actions"><button type="submit">予約する</button></div></form></div>`
        : b.status === "scheduled"
          ? `<div class="card"><p>${h(jst(b.scheduled_at))} に送信予定です。</p><form method="post" action="/admin/broadcasts/${h(b.id)}/cancel"><button class="danger" type="submit">予約を取り消して下書きに戻す</button></form></div>`
          : "";
    const sample = await renderSample(ctx, b.subject ?? "", b.body_markdown, b.body_format, b.footer_id);
    let results = "";
    if (b.status === "scheduled" && (isAbTest(b) || b.optimize_send_time)) {
      results = `<div class="card"><p style="margin:0">${icon(isAbTest(b) ? "test-tube" : "clock", 16)} ${
        isAbTest(b)
          ? `件名の A/B テスト：宛先の ${b.ab_percent}% に送り、${(b.ab_wait_minutes ?? 240) / 60} 時間後に勝った件名で残りに送ります。`
          : "読者ごとの「よく押す時刻」に合わせて、送信日時から 24 時間以内に送ります。"
      }</p></div>`;
    }
    if (isAbTest(b) && (b.status === "testing" || b.ab_winner)) {
      const stats = await abStats(ctx.db, b.id, b.ab_winner ? b.ab_decide_at : null);
      const row = (v: "a" | "b") => {
        const st = stats.find((x) => x.variant === v);
        return `<tr><td><b>${v.toUpperCase()}</b>${b.ab_winner === v ? ' <span class="pill good">勝ち</span>' : ""}</td><td>${h(v === "a" ? b.subject : b.subject_b)}</td>
<td>${st?.total ?? 0}</td><td>${pct(st?.clicked ?? 0, st?.sent ?? 0)}</td><td>${pct(st?.opened ?? 0, st?.sent ?? 0)}</td></tr>`;
      };
      results = `<section class="card"><h2 class="with-icon" style="margin-top:0">${icon("test-tube", 16)}件名の A/B テスト</h2>
<p class="muted" style="margin:0 0 8px">${b.ab_winner ? `${h(jst(b.ab_decide_at))} に ${b.ab_winner.toUpperCase()} に決まり、残りの読者に送りました。` : `${h(jst(b.ab_decide_at))} に勝ちを決めて、残りの読者に送ります。`}</p>
<div class="wrap"><table><tr><th></th><th>件名</th><th>テストで送った数</th><th>クリック率</th><th>開封率（目安）</th></tr>${row("a")}${row("b")}</table></div></section>`;
    }
    if (b.optimize_send_time && b.status === "sent") {
      const [w] = await ctx.db.query<{ waiting: number; total: number; first: Date | null; last: Date | null }>(
        `SELECT count(*) FILTER (WHERE status = 'queued')::int AS waiting, count(*)::int AS total, min(send_after) AS first, max(send_after) AS last
           FROM messages WHERE broadcast_id = $1`,
        [b.id],
      );
      results = `<div class="card"><p style="margin:0">${icon("clock", 16)} 読者ごとの時刻に送っています：まだ送っていないのは ${w?.waiting ?? 0} / ${w?.total ?? 0} 通${
        w?.last ? `（最後は ${h(jst(w.last))} ごろ）` : ""
      }。</p></div>`;
    }
    if (["sending", "sent", "testing"].includes(b.status)) {
      const st = await mailStats(ctx, "broadcast", b.id);
      results += `<section class="card"><div class="card-head"><h2>${icon("chart-no-axes-column", 16)} 結果</h2><a href="/admin/logs/mail/broadcast/${h(b.id)}">リンク別・読者別のレポート →</a></div>
<div class="grid kpi"><div class="stat"><b>${st.sent.toLocaleString("ja-JP")}</b><span>送信</span></div><div class="stat"><b>${pct(st.opened, st.sent)}</b><span>開封率（目安）</span></div><div class="stat"><b>${pct(st.clicked, st.sent)}</b><span>クリック率</span></div></div></section>`;
    }
    const initial = livePanel({ subject: sample.subject, html: sample.html, ...(count !== undefined ? { count } : {}), description: describe(seg, b.important) });
    const body = `${pageHeader({ title: b.subject || "一斉配信", badge: ` ${statusPill(b.status)}`, back: ["/admin/broadcasts", "一斉配信"], desc: readonly ? "送信済み・予約中の配信は編集できません。" : "プレビューはサンプルの読者「山田」さん宛てです。" })}
<div class="split"><div>${controls}${results}${editor(b, seg, count, readonly, await editorOptions(ctx))}</div>
<aside class="sticky">${liveSlot(initial, !readonly)}</aside></div>`;
    return c.html(adminPage({ title: "一斉配信", active: "/admin/broadcasts", body, flash: flashFrom(c) }));
  });

  app.post("/broadcasts/:id", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const r = await save(ctx, await readForm(c), id);
    if (r.error) return back(c, `/admin/broadcasts/${id}`, "err", r.error);
    await audit(ctx.db, "broadcast.update", id);
    return back(c, `/admin/broadcasts/${id}`, "ok", "保存しました");
  });

  app.get("/broadcasts/:id/preview", async (c) => {
    const ctx = await getCtx();
    const [b] = await ctx.db.query<BroadcastRow>("SELECT * FROM broadcasts WHERE id::text = $1", [c.req.param("id")]);
    if (!b) return c.text("not found", 404);
    const r = await renderSample(ctx, b.subject ?? "", b.body_markdown, b.body_format, b.footer_id);
    return previewResponse(c, r.html);
  });

  app.post("/broadcasts/:id/test", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const [b] = await ctx.db.query<BroadcastRow>("SELECT * FROM broadcasts WHERE id::text = $1", [id]);
    if (!b) return c.text("not found", 404);
    try {
      const n = await sendTest(ctx, b.subject ?? "", b.body_markdown, b.body_format, b.footer_id, {
        fromName: b.from_name ?? null,
        fromAddress: b.from_address ?? null,
        replyTo: b.reply_to ?? null,
      });
      await audit(ctx.db, "broadcast.test", id, { recipients: n });
      return back(c, `/admin/broadcasts/${id}`, "ok", `テスト送信しました（${n} 件）`);
    } catch (e) {
      return back(c, `/admin/broadcasts/${id}`, "err", `テスト送信できませんでした：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  app.post("/broadcasts/:id/schedule", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const f = await readForm(c);
    if (one(f, "confirm") !== "1") return back(c, `/admin/broadcasts/${id}`, "err", "確認のチェックを入れてください");
    const at = one(f, "at") ? fromJstInput(one(f, "at")) : ctx.now();
    if (!at) return back(c, `/admin/broadcasts/${id}`, "err", "送信日時の形式が正しくありません");
    const [b] = await ctx.db.query<BroadcastRow>("SELECT * FROM broadcasts WHERE id::text = $1", [id]);
    if (!b) return c.text("not found", 404);
    try {
      await assertTemplatesValid(ctx, b.subject ?? "", { text: b.body_markdown, format: b.body_format });
    } catch (e) {
      if (e instanceof TemplateError) return back(c, `/admin/broadcasts/${id}`, "err", e.message);
      throw e;
    }
    const rows = await ctx.db.query(
      "UPDATE broadcasts SET status = 'scheduled', scheduled_at = $2, updated_at = now() WHERE id::text = $1 AND status = 'draft' RETURNING id",
      [id, at < ctx.now() ? ctx.now() : at],
    );
    if (rows.length === 0) return back(c, `/admin/broadcasts/${id}`, "err", "下書き以外は予約できません");
    await audit(ctx.db, "broadcast.schedule", id, { at: at.toISOString() });
    return back(c, `/admin/broadcasts/${id}`, "ok", `${jst(at)} に予約しました（1 分以内に送信が始まります）`);
  });

  app.post("/broadcasts/:id/cancel", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const rows = await ctx.db.query(
      "UPDATE broadcasts SET status = 'draft', scheduled_at = NULL, updated_at = now() WHERE id::text = $1 AND status = 'scheduled' RETURNING id",
      [id],
    );
    await audit(ctx.db, "broadcast.cancel", id);
    return back(c, `/admin/broadcasts/${id}`, rows.length ? "ok" : "err", rows.length ? "予約を取り消しました" : "送信が始まっているため取り消せません");
  });
}

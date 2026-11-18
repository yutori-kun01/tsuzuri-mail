import { randomUUID } from "node:crypto";
import { checkSenderOverride, escapeHtml, renderEmail, resolveSender, type BodyFormat, type PlaceholderContext, type SenderOverride } from "@tsuzuri/core";
import type { Context } from "hono";
import { senderDomains, senderInfoUrl, url, type AppContext } from "../context.js";
import { formatJstDate } from "../time.js";
import { footerBody } from "../services/footers.js";
import { listCustomVariables } from "../services/variables.js";

export type Form = Record<string, string | string[]>;

/** フォームの値を読む（同じ名前が複数あれば配列） */
export async function readForm(c: Context): Promise<Form> {
  const body = await c.req.parseBody({ all: true });
  const out: Form = {};
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

export const one = (f: Form, k: string): string => {
  const v = f[k];
  return (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();
};
/** タグの欄：チェックボックス（複数）とカンマ区切りの入力のどちらでも受け取る */
export const tagsFrom = (f: Form, ...keys: string[]): string[] => [
  ...new Set(keys.flatMap((k) => many(f, k).flatMap((v) => list(v))).filter((t) => t.length <= 40)),
];

/** タグの一覧と、配信中の読者の人数（タグを選ぶ欄で使う） */
export async function tagsWithCounts(ctx: AppContext): Promise<{ name: string; count: number }[]> {
  return ctx.db.query<{ name: string; count: number }>(
    `SELECT t.name, (SELECT count(*) FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id WHERE ct.tag_id = t.id AND c.status = 'active')::int AS count
       FROM tags t ORDER BY t.name`,
  );
}

export const many = (f: Form, k: string): string[] => {
  const v = f[k];
  return Array.isArray(v) ? v : v ? [v] : [];
};
export const list = (s: string): string[] =>
  s
    .split(/[,、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** 完了・エラーの一言をリダイレクト先に載せる */
export function back(c: Context, path: string, kind: "ok" | "err", text: string) {
  const sep = path.includes("?") ? "&" : "?";
  return c.redirect(`${path}${sep}${kind}=${encodeURIComponent(text)}`, 303);
}

export function flashFrom(c: Context): { kind: "ok" | "error"; text: string } | undefined {
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  if (err) return { kind: "error", text: err.slice(0, 300) };
  if (ok) return { kind: "ok", text: ok.slice(0, 300) };
  return undefined;
}

/** プレビュー・テスト送信用のサンプル値 */
export async function sampleContext(ctx: AppContext): Promise<PlaceholderContext> {
  const s = ctx.settings;
  return {
    builtins: {
      name: "山田",
      email: "reader@example.com",
      date: formatJstDate(ctx.now()),
      sender: s.senderName,
      contact: s.contact,
      sender_info: senderInfoUrl(ctx),
      subscribed_date: formatJstDate(ctx.now()),
      cancel: url(ctx, "/u/preview"),
      settings: url(ctx, "/p/preview"),
      download: url(ctx, "/d/preview"),
      webview: url(ctx, "/w/preview"),
      confirm: url(ctx, "/confirm/preview"),
    },
    custom: await listCustomVariables(ctx.db),
    attributes: {},
  };
}

/** footerId：一斉配信・シナリオで選んだフッター（null・省略なら既定のフッター） */
export async function renderSample(ctx: AppContext, subject: string, body: string, format: BodyFormat, footerId?: string | null) {
  const s = ctx.settings;
  const footerTemplate = await footerBody(ctx.db, footerId);
  return renderEmail({
    subject,
    body,
    format,
    context: await sampleContext(ctx),
    footer: { senderName: s.senderName || "（送信者名未設定）", contact: s.contact || "（問い合わせ先未設定）", senderInfoUrl: senderInfoUrl(ctx) },
    unsubscribeUrl: url(ctx, "/u/preview"),
    preferencesUrl: url(ctx, "/p/preview"),
    ...(footerTemplate ? { footerTemplate } : {}),
  });
}

/** 設定のテスト送信先にだけ送る（読者には送らない・記録しない） */
export async function sendTest(
  ctx: AppContext,
  subject: string,
  body: string,
  format: BodyFormat,
  footerId?: string | null,
  senderOverride?: SenderOverride | null,
): Promise<number> {
  const to = ctx.settings.testRecipients ?? [];
  if (to.length === 0) throw new Error("設定画面で「テスト送信先」を登録してください");
  const r = await renderSample(ctx, subject, body, format, footerId);
  const base = ctx.settings;
  const sender = resolveSender({ fromName: base.fromName, fromAddress: base.fromAddress, ...(base.replyTo ? { replyTo: base.replyTo } : {}) }, senderOverride);
  for (const addr of to) {
    await ctx.provider.send({
      idempotencyKey: `test:${randomUUID()}`,
      to: addr,
      from: { address: sender.fromAddress, name: sender.fromName },
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      subject: `[テスト] ${r.subject}`,
      html: r.html,
      text: r.text,
      headers: {},
      tags: { kind: "test" },
    });
  }
  return to.length;
}

/** プレビュー用のページ（iframe で表示する） */
export function previewResponse(c: Context, html: string) {
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'self'; base-uri 'none'");
  c.header("X-Frame-Options", "SAMEORIGIN");
  return c.html(html);
}

/** シナリオ・一斉配信の「送信者」欄（空欄なら設定の送信者を使う） */
export function senderFieldsHtml(
  ctx: AppContext,
  row: { from_name?: string | null; from_address?: string | null; reply_to?: string | null },
  inline = false,
): string {
  const e = escapeHtml;
  const s = ctx.settings;
  const domains = senderDomains(ctx);
  const fields = `<div class="row"><div><label>送信者名</label><input type="text" name="from_name" maxlength="60" value="${e(row.from_name ?? "")}" placeholder="${e(s.fromName)}"></div>
<div><label>送信元アドレス</label><input type="email" name="from_address" value="${e(row.from_address ?? "")}" placeholder="${e(s.fromAddress)}"></div>
<div><label>返信先（任意）</label><input type="email" name="reply_to" value="${e(row.reply_to ?? "")}" placeholder="${e(s.replyTo ?? "")}"></div></div>
<p class="muted" style="margin:8px 0 0">送信元アドレスに使えるドメイン：${domains.map((d) => `<code>@${e(d)}</code>`).join("、")}。別のドメインから送るには、先に<a href="/admin/domains">送信ドメイン</a>を登録します。</p>`;
  // 既定の送信者は、この tsuzuri を使っている人の「設定」の値（環境ごとに違う。決め打ちの値は出さない）
  const note = s.fromAddress
    ? `空欄なら設定の送信者「${e(s.fromName || "（送信者名なし）")}」&lt;${e(s.fromAddress)}&gt; で送ります`
    : `空欄なら<a href="/admin/settings">設定</a>の送信者で送ります（まだ設定されていません）`;
  if (inline) return `<p class="muted" style="margin:4px 0 0">${note}。</p>${fields}`;
  return `<details class="sender-box"${row.from_name || row.from_address || row.reply_to ? " open" : ""}><summary>送信者を変える（${note}）</summary>
${fields}</details>`;
}

/** 送信者欄の入力を検証する（空欄は NULL = 設定の送信者を使う） */
export function readSenderFields(ctx: AppContext, f: Form): { value: { fromName: string | null; fromAddress: string | null; replyTo: string | null } } | { error: string } {
  const v = {
    fromName: one(f, "from_name").trim() || null,
    fromAddress: one(f, "from_address").trim().toLowerCase() || null,
    replyTo: one(f, "reply_to").trim() || null,
  };
  const problem = checkSenderOverride(v, senderDomains(ctx));
  return problem ? { error: problem } : { value: v };
}

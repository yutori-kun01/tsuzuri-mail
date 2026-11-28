import { Marked } from "marked";
import { tokenize, substitute, type PlaceholderContext, type ResolvedValue } from "./placeholders.js";

const marked = new Marked({ gfm: true, breaks: true });

const FONT = "-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif";
/** フッターの帯の背景（本文は白のまま、フッターだけ薄いグレーにする） */
const FOOTER_BG = "#f4f4f2";
const FOOTER_INK = "#666666";

/** フッターを、画面幅いっぱいの薄いグレーの帯に入れる（表で組むと Outlook でも背景が出る） */
function footerBand(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:32px;background:${FOOTER_BG};border-collapse:collapse"><tr><td style="padding:0">
<div style="max-width:600px;margin:0 auto;padding:20px 20px 28px;font-family:${FONT};font-size:12px;color:${FOOTER_INK};line-height:1.7">${inner.replace(/<a /g, `<a style="color:${FOOTER_INK}" `)}</div>
</td></tr></table>`;
}

/** Markdown から作った本文に、最小限の見た目だけを付ける（色や装飾は付けず、テキストメールに近い見た目にする） */
function styleMarkdownHtml(html: string): string {
  return html
    .replace(/<h1>/g, '<h1 style="font-size:20px;line-height:1.5;margin:1.6em 0 0.6em">')
    .replace(/<h2>/g, '<h2 style="font-size:18px;line-height:1.5;margin:1.6em 0 0.6em">')
    .replace(/<h([3-6])>/g, '<h$1 style="font-size:16px;line-height:1.5;margin:1.4em 0 0.5em">')
    .replace(/<p>/g, '<p style="margin:0 0 1em">')
    .replace(/<blockquote>/g, '<blockquote style="margin:0 0 1em;padding:0 0 0 12px;border-left:3px solid #dddddd;color:#555555">')
    .replace(/<hr>/g, '<hr style="border:none;border-top:1px solid #dddddd;margin:24px 0">')
    .replace(/<img /g, '<img style="max-width:100%;height:auto" ')
    .replace(/<a /g, '<a style="color:#1a5fb4" ');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 本文の書き方。markdown は自動でレイアウトに入れる。html は書いた HTML をそのまま使う */
export type BodyFormat = "markdown" | "html";

export interface FooterSettings {
  /** 送信者の氏名・名称（特定電子メール法の表示） */
  senderName: string;
  /** 問い合わせ先（URL またはメールアドレス） */
  contact: string;
  /**
   * 住所などの送信者情報を載せたページの URL。
   * 住所はメール本文ではなく、このリンク先で表示する（「送信者情報（住所など）」と明示したリンクを置く）
   */
  senderInfoUrl?: string;
  /** フッターに追加する行（任意） */
  extraLines?: readonly string[];
}

export interface TrackingOptions {
  /** i 番目のリンクの計測用 URL を返す */
  clickUrl: (index: number) => string;
  /** 開封計測の画像 URL（省略で付けない） */
  openPixelUrl?: string;
}

export interface RenderInput {
  subject: string;
  body: string;
  /** 省略時は markdown */
  format?: BodyFormat;
  context: PlaceholderContext;
  footer: FooterSettings;
  /**
   * フッターのひな形（Markdown、置き換え文字可）。省略時は標準のフッター。
   * Web 版（unsubscribeUrl が空）では使わない（個人用のリンクを出さないため）。フッターのリンクはクリック計測しない
   */
  footerTemplate?: string;
  /** 配信停止 URL（フッターに必ず入れる）。空文字は Web 版用で、個人用リンクを出さない */
  unsubscribeUrl: string;
  preferencesUrl?: string;
  tracking?: TrackingOptions;
}

export interface TrackedLink {
  index: number;
  url: string;
  /** 本文最後のリンク（クリックを読了の代理指標として数える） */
  isLast: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  links: TrackedLink[];
}

const MARKER = /TZPH\d+X/g;

/** 属性値の中の目印は、エスケープした値に置き換える（リンク化しない） */
function replaceMarkersInAttributes(html: string, values: Map<string, ResolvedValue>): string {
  return html.replace(/(\s[\w:-]+=)(["'])([^"']*TZPH\d+X[^"']*)\2/g, (_w, name: string, q: string, val: string) => {
    const replaced = val.replace(MARKER, (m) => {
      const v = values.get(m);
      return v ? escapeHtml(v.value) : m;
    });
    return `${name}${q}${replaced}${q}`;
  });
}

function replaceMarkers(s: string, values: Map<string, ResolvedValue>, mode: "html" | "html-autolink" | "text"): string {
  return s.replace(MARKER, (m) => {
    const v = values.get(m);
    if (!v) return m;
    if (mode === "text") return v.value;
    // Markdown の本文中にそのまま置かれた URL 型の値はリンクにする
    if (mode === "html-autolink" && v.kind === "url" && /^https?:\/\//.test(v.value)) {
      const u = escapeHtml(v.value);
      return `<a href="${u}">${u}</a>`;
    }
    return escapeHtml(v.value);
  });
}

function markdownToText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/^>\s?/gm, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** HTML からテキスト版を作る（リンクは「文字（URL）」にする） */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*?href=(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi, (_w, _q, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `${label}（${href}）` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "・")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_w, e: string) => ENTITIES[e] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** href を計測用 URL に差し替える。配信停止など untracked な値と mailto は対象外。 */
function rewriteLinks(
  html: string,
  values: Map<string, ResolvedValue>,
  tracking: TrackingOptions | undefined,
): { html: string; links: TrackedLink[] } {
  const links: TrackedLink[] = [];
  const out = html.replace(/<a\b([^>]*?)\shref=(["'])([^"']*)\2/gi, (_w, before: string, _q: string, href: string) => {
    const marker = /^TZPH\d+X$/.exec(href)?.[0];
    const resolved = marker ? values.get(marker) : undefined;
    const url = marker ? (resolved?.value ?? "") : href.replace(/&amp;/g, "&");
    if (!/^https?:\/\//.test(url) || resolved?.untracked || !tracking) {
      return `<a${before} href="${escapeHtml(url)}"`;
    }
    const index = links.length;
    links.push({ index, url, isLast: false });
    return `<a${before} href="${escapeHtml(tracking.clickUrl(index))}"`;
  });
  const last = links.at(-1);
  if (last) last.isLast = true;
  return { html: out, links };
}

function footerHtml(f: FooterSettings, unsubscribeUrl: string, preferencesUrl?: string): string {
  const lines = [`送信者：${escapeHtml(f.senderName)}`, `お問い合わせ：${escapeHtml(f.contact)}`, ...(f.extraLines ?? []).map(escapeHtml)];
  if (f.senderInfoUrl) lines.push(`<a href="${escapeHtml(f.senderInfoUrl)}">送信者情報（住所など）はこちら</a>`);
  // unsubscribeUrl が空 = Web 版。個人用リンクを出さない
  const links: string[] = [];
  if (unsubscribeUrl) links.push(`<a href="${escapeHtml(unsubscribeUrl)}">配信停止</a>`);
  if (unsubscribeUrl && preferencesUrl) links.push(`<a href="${escapeHtml(preferencesUrl)}">配信設定</a>`);
  const linkLine = links.length > 0 ? `<br>${links.join(" ｜ ")}` : "";
  return footerBand(`<p style="margin:0">${lines.join("<br>")}${linkLine}</p>`);
}

/** フッターのひな形を HTML とテキストにする（リンクは計測しない） */
function footerFromTemplate(tpl: string, context: PlaceholderContext): { html: string; text: string } {
  const { text: withMarkers, values } = tokenize(tpl, context);
  const raw = marked.parse(withMarkers, { async: false });
  const html = replaceMarkers(replaceMarkersInAttributes(raw, values), values, "html-autolink")
    .replace(/<p>/g, '<p style="margin:0 0 8px">');
  return {
    html: footerBand(html),
    text: ["", "――――――――", replaceMarkers(markdownToText(withMarkers), values, "text").trim()].join("\n"),
  };
}

const REQUIRED_IN_FOOTER: { label: string; names: string[] }[] = [
  { label: "%cancel%（配信停止のリンク）", names: ["cancel", "配信解除", "配信停止", "unsubscribe"] },
  { label: "%sender%（送信者名）", names: ["sender", "送信者"] },
  { label: "%sender_info%（送信者情報のページ。住所・問い合わせ先を載せる）", names: ["sender_info", "送信者情報"] },
];

/** フッターのひな形に足りないもの（法定表示のため。空なら問題なし） */
export function footerProblems(tpl: string): string[] {
  return REQUIRED_IN_FOOTER.filter((r) => !r.names.some((n) => new RegExp(`%${n}(\\|[^%]*)?%`).test(tpl))).map((r) => r.label);
}

function footerText(f: FooterSettings, unsubscribeUrl: string, preferencesUrl?: string): string {
  return [
    "",
    "――――――――",
    `送信者：${f.senderName}`,
    `お問い合わせ：${f.contact}`,
    ...(f.extraLines ?? []),
    ...(f.senderInfoUrl ? [`送信者情報（住所など）：${f.senderInfoUrl}`] : []),
    ...(unsubscribeUrl ? [`配信停止：${unsubscribeUrl}`] : []),
    ...(unsubscribeUrl && preferencesUrl ? [`配信設定：${preferencesUrl}`] : []),
  ].join("\n");
}

function layout(subject: string, body: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:600px;margin:0 auto;padding:32px 20px 0;font-family:${FONT};font-size:16px;line-height:1.8;color:#222222">
${body}
</div>
<!--tz-footer--></body></html>`;
}

/** 完全な HTML 文書なら </body> の直前に、断片ならレイアウトに入れてから差し込む */
function insertBeforeBodyEnd(doc: string, addition: string): string {
  const i = doc.search(/<\/body>/i);
  return i >= 0 ? doc.slice(0, i) + addition + doc.slice(i) : doc + addition;
}

/** 件名・本文の置き換え、Markdown→HTML（または HTML そのまま）、リンク計測、法定フッターをまとめて行う。 */
export function renderEmail(input: RenderInput): RenderedEmail {
  const format = input.format ?? "markdown";
  const subject = substitute(input.subject, input.context).replace(/\s+/g, " ").trim();
  const { text: withMarkers, values } = tokenize(input.body, input.context, { html: format === "html" });

  // 1. 本文を HTML にする（置き換え文字は目印のまま）
  const rawHtml = format === "markdown" ? marked.parse(withMarkers, { async: false }) : withMarkers;
  const fullDocument = format === "html" && /<body[\s>]/i.test(rawHtml);

  // 2. リンク計測の差し替え → 属性の中の目印 → 本文の目印
  const { html: linked, links } = rewriteLinks(rawHtml, values, input.tracking);
  const attrsDone = replaceMarkersInAttributes(linked, values);
  const replaced = replaceMarkers(attrsDone, values, format === "markdown" ? "html-autolink" : "html");
  const bodyHtml = format === "markdown" ? styleMarkdownHtml(replaced) : replaced;

  // 3. フッターと開封計測を入れる
  const custom = input.footerTemplate && input.unsubscribeUrl ? footerFromTemplate(input.footerTemplate, input.context) : undefined;
  let addition = custom ? custom.html : footerHtml(input.footer, input.unsubscribeUrl, input.preferencesUrl);
  if (input.tracking?.openPixelUrl) {
    addition += `<img src="${escapeHtml(input.tracking.openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0">`;
  }
  const html = fullDocument
    ? insertBeforeBodyEnd(bodyHtml, addition)
    : layout(subject, bodyHtml).replace("<!--tz-footer-->", addition);

  // 4. テキスト版（計測前の元の URL を使う）
  const bodyText =
    format === "markdown"
      ? replaceMarkers(markdownToText(withMarkers), values, "text").trim()
      : htmlToText(replaceMarkers(replaceMarkersInAttributes(rawHtml, values), values, "html"));
  const text = bodyText + "\n" + (custom ? custom.text : footerText(input.footer, input.unsubscribeUrl, input.preferencesUrl));

  return { subject, html, text, links };
}

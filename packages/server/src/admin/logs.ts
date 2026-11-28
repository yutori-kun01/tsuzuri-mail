import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import {
  linkStats,
  listMails,
  MAIL_TYPES,
  mailHeader,
  mailStats,
  reactionTimeline,
  recipients,
  RECIPIENT_FILTERS,
  type MailRow,
  type MailType,
  type RecipientFilter,
} from "../services/reports.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, jst, pageHeader, pct, statusPill, tabs } from "./ui.js";

/**
 * 配信ログ（メールごと）と、メールごとのレポート。
 * 一斉配信 1 本・シナリオの 1 通・フォームの確認メールを 1 行にまとめ、押すとそのメールの開封・クリック・リンク別・読者別が見られる。
 */

const TYPE_LABEL: Record<MailType, string> = { broadcast: "一斉配信", step: "シナリオ", optin: "確認メール", deleted: "削除したシナリオ" };

export function mailReportUrl(type: MailType, ref: string, q: Record<string, string> = {}): string {
  const qs = new URLSearchParams(q).toString();
  return `/admin/logs/mail/${type}/${encodeURIComponent(ref)}${qs ? `?${qs}` : ""}`;
}

export function logViewTabs(current: "mails" | "messages"): string {
  return tabs([
    { href: "/admin/logs", label: "メールごと", current: current === "mails" },
    { href: "/admin/logs/messages", label: "1 通ずつ", current: current === "messages" },
  ]);
}

function pager(o: { total: number; page: number; per: number; href: (page: number) => string }): string {
  const pages = Math.max(1, Math.ceil(o.total / o.per));
  if (pages <= 1) return "";
  return `<div class="log-bar"><span class="muted">全 ${o.total.toLocaleString("ja-JP")} 件</span><span class="log-pages">${
    o.page > 1 ? `<a class="btn sub" href="${o.href(o.page - 1)}">${icon("arrow-left", 14)}前へ</a>` : ""
  }<span class="muted">${o.page} / ${pages} ページ</span>${o.page < pages ? `<a class="btn sub" href="${o.href(o.page + 1)}">次へ${icon("arrow-right", 14)}</a>` : ""}</span></div>`;
}

const LOG_STYLE = `<style>
.log-bar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);margin:var(--space-3) 0}
.log-pages{margin-left:auto;display:inline-flex;gap:var(--space-2);align-items:center}.log-pages .btn{height:30px;padding:0 var(--space-3);font-size:13px}
.mail-table td{white-space:normal;vertical-align:top}.mail-table .sub-line{display:block;color:var(--ink-muted);font-size:12px;line-height:18px;margin-top:2px}
.kind{display:inline-block;font-size:11px;padding:0 6px;border-radius:var(--radius-pill);background:var(--surface-sunken);color:var(--ink-muted);margin-right:6px;vertical-align:1px}
.rate b{font-variant-numeric:tabular-nums}.rate small{display:block;color:var(--ink-muted);font-size:12px}
.rep-kpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3);margin-bottom:var(--space-4)}
@media (max-width:900px){.rep-kpi{grid-template-columns:repeat(2,minmax(0,1fr))}}
.rep-kpi .stat b small{font-size:14px;color:var(--ink-muted);font-weight:500;margin-left:4px}
.funnel{display:grid;gap:var(--space-2)}
.funnel-row{display:grid;grid-template-columns:120px minmax(0,1fr) 120px;gap:var(--space-3);align-items:center;font-size:13px}
.funnel-row .bar-track{height:12px}
.funnel-row b{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
@media (max-width:640px){.funnel-row{grid-template-columns:minmax(0,1fr) 110px}.funnel-row .bar-track{grid-column:1 / -1;order:3}}
.link-url{overflow-wrap:anywhere;word-break:break-all;font-size:13px}
.wrap td.link-url{white-space:normal}
.filter-note{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;margin:0 0 var(--space-2)}
</style>`;

function rateCell(n: number, d: number): string {
  return `<td class="rate"><b>${pct(n, d)}</b><small>${n.toLocaleString("ja-JP")} 人</small></td>`;
}

function mailTitle(r: Pick<MailRow, "type" | "title" | "origin" | "position">): string {
  const title = h(r.title || "（件名なし）");
  const sub = r.type === "step" ? `${h(r.origin)} ・ ${r.position} 通目` : r.type === "optin" ? `フォーム「${h(r.origin)}」` : r.type === "deleted" ? "元のシナリオは削除済み" : "";
  return `<span class="kind">${TYPE_LABEL[r.type]}</span>${title}${sub ? `<span class="sub-line">${sub}</span>` : ""}`;
}

export function registerMailLogs(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/logs", async (c) => {
    const ctx = await getCtx();
    const raw = c.req.query("type") ?? "";
    const type = (MAIL_TYPES as readonly string[]).includes(raw) ? (raw as MailType) : undefined;
    const per = 30;
    const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
    const { rows, total } = await listMails(ctx, { ...(type ? { type } : {}), limit: per, offset: (page - 1) * per });
    const href = (o: { type?: MailType | ""; page?: number }) => {
      const q = new URLSearchParams();
      const t = o.type === undefined ? type : o.type;
      if (t) q.set("type", t);
      if ((o.page ?? 1) > 1) q.set("page", String(o.page));
      const qs = q.toString();
      return `/admin/logs${qs ? `?${qs}` : ""}`;
    };
    const filters = tabs([
      { href: href({ type: "" }), label: "すべて", current: !type },
      ...(["broadcast", "step", "optin", "deleted"] as const).map((t) => ({ href: href({ type: t }), label: TYPE_LABEL[t], current: type === t })),
    ]);
    const table = rows.length
      ? `<div class="wrap"><table class="mail-table"><tr><th>メール</th><th style="width:140px">最後の送信</th><th>送信</th><th>開封率</th><th>クリック率</th><th>配信停止</th><th>エラー</th></tr>${rows
          .map(
            (r) => `<tr><td><a href="${mailReportUrl(r.type, r.ref)}">${mailTitle(r)}</a></td><td>${h(jst(r.lastAt))}</td>
<td>${r.sent.toLocaleString("ja-JP")}${r.queued ? `<span class="sub-line">送信待ち ${r.queued}</span>` : ""}</td>${rateCell(r.opened, r.sent)}${rateCell(r.clicked, r.sent)}
<td>${r.unsubscribed}</td><td>${r.bounced + r.complained + r.failed ? `<span class="pill warn">${r.bounced + r.complained + r.failed}</span>` : "0"}</td></tr>`,
          )
          .join("")}</table></div>`
      : emptyState({ icon: "scroll-text", title: "まだ送ったメールはありません", text: "一斉配信やシナリオのメールを送ると、メールごとにここへまとまります。" });
    const body = `${pageHeader({ title: "配信ログ", desc: "送ったメールごとにまとめています。件名を押すと、そのメールの開封・クリック（リンク別）・受け取った読者を確認できます。" })}
${LOG_STYLE}${logViewTabs("mails")}${filters}${table}${pager({ total, page, per, href: (p) => href({ page: p }) })}
<p class="muted" style="margin-top:12px">開封率は機械開封（Apple のプライバシー保護など）を除いた目安です。クリック率の方が信頼できます。配信停止は、受け取ってから 7 日以内に停止した人の数です。</p>`;
    return c.html(adminPage({ title: "配信ログ", active: "/admin/logs", body }));
  });

  app.get("/logs/mail/:type/:ref", async (c) => {
    const ctx = await getCtx();
    const rawType = c.req.param("type");
    const ref = c.req.param("ref");
    const type = (MAIL_TYPES as readonly string[]).includes(rawType) ? (rawType as MailType) : undefined;
    const head = type ? await mailHeader(ctx, type, ref) : undefined;
    if (!type || !head) {
      return c.html(adminPage({ title: "配信ログ", active: "/admin/logs", body: emptyState({ icon: "circle-x", title: "見つかりません", text: "削除されたか、URL が間違っている可能性があります。" }) }), 404);
    }
    const filterRaw = c.req.query("filter") ?? "all";
    const filter = (RECIPIENT_FILTERS as readonly string[]).includes(filterRaw) ? (filterRaw as RecipientFilter) : "all";
    const linkFilter = c.req.query("url") ?? "";
    const per = 50;
    const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
    const st = await mailStats(ctx, type, ref);
    const links = await linkStats(ctx, type, ref);
    const timeline = await reactionTimeline(ctx, type, ref);
    const list = await recipients(ctx, type, ref, { filter, ...(linkFilter ? { url: linkFilter } : {}), limit: per, offset: (page - 1) * per });

    const self = (q: { filter?: RecipientFilter; url?: string; page?: number }) => {
      const o: Record<string, string> = {};
      const f = q.filter ?? filter;
      if (f !== "all") o.filter = f;
      const u = q.url === undefined ? linkFilter : q.url;
      if (u) o.url = u;
      if ((q.page ?? 1) > 1) o.page = String(q.page);
      return mailReportUrl(type, ref, o);
    };

    const backLink: [string, string] =
      type === "broadcast" ? [`/admin/broadcasts/${encodeURIComponent(ref)}`, "一斉配信に戻る"] : type === "step" && head.originId ? [`/admin/sequences/${encodeURIComponent(head.originId)}?tab=analytics`, "シナリオの分析に戻る"] : ["/admin/logs", "配信ログ"];
    const editLink =
      type === "broadcast"
        ? `<a class="btn sub" href="/admin/broadcasts/${h(ref)}">${icon("send", 16)}配信を開く</a>`
        : type === "step" && head.originId
          ? `<a class="btn sub" href="/admin/sequences/${h(head.originId)}/steps/${h(ref)}">${icon("pencil", 16)}この通を編集</a>`
          : type === "optin"
            ? `<a class="btn sub" href="/admin/forms/${h(ref)}?tab=confirm">${icon("file-input", 16)}フォームを開く</a>`
            : "";

    const kpi = `<div class="rep-kpi">
<div class="stat"><b>${st.sent.toLocaleString("ja-JP")}</b><span>送信${st.queued ? `（ほかに送信待ち ${st.queued}）` : ""}</span></div>
<div class="stat"><b>${pct(st.opened, st.sent)}<small>${st.opened} 人</small></b><span>開封率（目安）</span></div>
<div class="stat"><b>${pct(st.clicked, st.sent)}<small>${st.clicked} 人</small></b><span>クリック率</span></div>
<div class="stat"><b>${pct(st.clicked, st.opened)}</b><span>開封した人のうちクリック</span></div></div>`;

    const max = Math.max(1, st.sent);
    const fr = (label: string, n: number, color: string, note: string) =>
      `<div class="funnel-row"><span>${label}</span><div class="bar-track"><span style="width:${Math.round((n / max) * 100)}%;background:${color}"></span></div><b>${n.toLocaleString("ja-JP")}<span class="muted"> ${note}</span></b></div>`;
    const funnel = `<section class="card"><h2 style="margin-top:0">届いてから反応まで</h2><div class="funnel">
${fr("送信", st.sent, "var(--chart-2)", "")}
${fr("配達を確認", st.delivered, "var(--chart-2)", pct(st.delivered, st.sent))}
${fr("開封", st.opened, "var(--chart-3)", pct(st.opened, st.sent))}
${fr("クリック", st.clicked, "var(--chart-1)", pct(st.clicked, st.sent))}
${fr("配信停止（7 日以内）", st.unsubscribed, "var(--chart-4)", pct(st.unsubscribed, st.sent))}
</div><p class="muted" style="margin:12px 0 0">バウンス ${st.bounced}・苦情 ${st.complained}・失敗 ${st.failed}・送らなかった（停止中など） ${st.skipped}。${st.firstAt ? `最初の送信 ${h(jst(st.firstAt))}。` : ""}</p></section>`;

    const BUCKETS = ["1 時間以内", "6 時間以内", "24 時間以内", "3 日以内", "それ以降"];
    const timelineCard = timeline.length
      ? `<section class="card"><h2 style="margin-top:0">送ってから反応するまでの時間</h2><div class="wrap"><table><tr><th>送ってから</th><th>開封した人</th><th>クリックした人</th></tr>${BUCKETS.map((b, i) => {
          const t = timeline.find((x) => x.bucket === i);
          return `<tr><td>${b}</td><td>${t?.opened ?? 0}</td><td>${t?.clicked ?? 0}</td></tr>`;
        }).join("")}</table></div><p class="muted" style="margin:8px 0 0">次に送る時刻を決めるときの参考になります。</p></section>`
      : "";

    const linkTable = `<section class="card"><h2 style="margin-top:0">リンクごとのクリック</h2>${
      links.length
        ? `<div class="wrap"><table><tr><th>リンク先</th><th>押した人</th><th>クリック率</th><th>押された回数</th><th></th></tr>${links
            .map(
              (l) => `<tr><td class="link-url">${h(l.url)}</td><td>${l.clickers}</td><td>${pct(l.clickers, st.sent)}</td><td>${l.clicks}</td>
<td>${l.clickers ? `<a href="${self({ filter: "all", url: l.url })}#readers">押した人を見る</a>` : ""}</td></tr>`,
            )
            .join("")}</table></div><p class="muted" style="margin:8px 0 0">配信停止・配信設定・特典のリンクは計測していないため、ここには出ません。ボットと判定したクリックは除いています。</p>`
        : '<p class="muted" style="margin:0">計測しているリンクがありません。</p>'
    }</section>`;

    const FILTER_LABEL: Record<RecipientFilter, string> = {
      all: "すべて",
      opened: "開封した",
      not_opened: "開封していない",
      clicked: "クリックした",
      not_clicked: "クリックしていない",
      bounced: "バウンス・苦情",
      failed: "失敗・送らなかった",
    };
    const ftabs = tabs(RECIPIENT_FILTERS.map((f) => ({ href: `${self({ filter: f, page: 1 })}#readers`, label: FILTER_LABEL[f], current: f === filter })));
    const readers = `<section class="card" id="readers"><h2 style="margin-top:0">受け取った読者</h2>${ftabs}
${linkFilter ? `<p class="filter-note"><span class="pill info">リンク：${h(linkFilter.length > 60 ? `${linkFilter.slice(0, 60)}…` : linkFilter)}</span>を押した人だけ <a href="${self({ url: "", page: 1 })}#readers">解除</a></p>` : ""}
${
  list.rows.length
    ? `<div class="wrap"><table class="mail-table"><tr><th>読者</th><th>状態</th><th style="width:140px">送信</th><th style="width:140px">開封</th><th>クリック</th></tr>${list.rows
        .map(
          (r) => `<tr><td><a href="/admin/readers/${h(r.contact_id)}">${h(r.address)}</a>${r.display_name ? `<span class="sub-line">${h(r.display_name)}</span>` : ""}</td>
<td>${statusPill(r.status)}${r.variant ? ` <span class="pill">件名 ${h(r.variant.toUpperCase())}</span>` : ""}${r.error ? `<span class="sub-line">${h(r.error)}</span>` : ""}</td>
<td>${h(jst(r.sent_at ?? r.queued_at))}</td><td>${r.first_open ? h(jst(r.first_open)) : '<span class="muted">—</span>'}</td><td>${r.clicks ? `${r.clicks} 回` : '<span class="muted">—</span>'}</td></tr>`,
        )
        .join("")}</table></div>${pager({ total: list.total, page, per, href: (p) => `${self({ page: p })}#readers` })}`
    : '<p class="muted" style="margin:0">該当する読者はいません。</p>'
}</section>`;

    const where = type === "step" ? `${head.origin ?? ""} ・ ${head.position} 通目` : type === "optin" ? `フォーム「${head.origin ?? ""}」の確認メール` : TYPE_LABEL[type];
    const body = `${pageHeader({ title: head.title || "（件名なし）", back: backLink, desc: where, ...(editLink ? { actions: editLink } : {}) })}
${LOG_STYLE}${kpi}${funnel}${linkTable}${timelineCard}${readers}`;
    return c.html(adminPage({ title: "メールのレポート", active: "/admin/logs", body }));
  });
}

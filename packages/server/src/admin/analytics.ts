import { stepFlags, type Flag } from "@tsuzuri/core";
import type { SequenceAnalytics, StepStats } from "../services/analytics.js";
import { icon } from "./icons.js";
import { h, pct } from "./ui.js";
import { PERIODS } from "./routes.js";

/**
 * シナリオ画面の「分析」。グラフは管理画面の中で CSS の横棒で描く（外部のグラフ用スクリプトは使わない）。
 * どのグラフも 1 系列なので凡例は置かず、見出しが何の値かを示す。数値は表でも見られる。
 */

const FLAG_LABEL: Record<Flag, [string, string]> = {
  "low-click": ["warn", "クリック率が平均の半分未満"],
  "unsub-warn": ["warn", "配信停止がやや多い（0.5% 以上）"],
  "unsub-bad": ["bad", "配信停止が多い（1% 以上）"],
  "big-drop": ["warn", "前の通から届いた人が大きく減っている"],
};

const rate = (n: number, d: number) => (d > 0 ? n / d : 0);
const pctText = (n: number, d: number) => (d > 0 ? `${(Math.round((n / d) * 1000) / 10).toFixed(1)}%` : "—");

function label(s: StepStats): string {
  const subject = s.subject.length > 22 ? `${s.subject.slice(0, 22)}…` : s.subject;
  return `<span class="an-num">${s.position}</span><span class="an-subj" title="${h(s.subject)}">${h(subject || "（件名なし）")}</span>`;
}

/** 1 系列の横棒グラフ。value は 0〜1 の割合か件数。scale は棒の最大値 */
function barChart(o: { title: string; note: string; steps: StepStats[]; value: (s: StepStats) => number; text: (s: StepStats) => string; tip: (s: StepStats) => string; scale: number; color: string; flagged?: (s: StepStats) => boolean }): string {
  const rows = o.steps
    .map((s) => {
      const v = o.value(s);
      const w = o.scale > 0 ? Math.max(v > 0 ? 2 : 0, Math.round((v / o.scale) * 100)) : 0;
      return `<div class="an-row${o.flagged?.(s) ? " flagged" : ""}" title="${h(o.tip(s))}"><div class="an-label">${label(s)}</div>
<div class="an-track"><span style="width:${w}%;background:${o.color}"></span></div><div class="an-val">${h(o.text(s))}</div></div>`;
    })
    .join("");
  return `<section class="card an-chart"><h2 style="margin:0">${o.title}</h2><p class="muted" style="margin:2px 0 12px">${o.note}</p>${rows || '<p class="muted">まだ通がありません。</p>'}</section>`;
}

export function analyticsPanel(a: SequenceAnalytics, days: number, seqId: string): string {
  const flags = stepFlags(a.steps);
  const period = `<nav class="tabs">${PERIODS.map(
    ([d, l]) => `<a href="/admin/sequences/${h(seqId)}?tab=analytics&amp;days=${d}"${d === days ? ' aria-current="page"' : ""}>${h(l)}</a>`,
  ).join("")}</nav>`;
  const kpi = `<div class="an-kpi">
<div class="stat"><b>${a.entered}</b><span>シナリオに入った人</span></div>
<div class="stat"><b>${a.completed}<small> ${pctText(a.completed, a.entered)}</small></b><span>最後まで届いた人（完了率）</span></div>
<div class="stat"><b>${a.active}</b><span>進行中</span></div>
<div class="stat"><b>${a.unsubscribed}</b><span>このシナリオの途中で配信停止</span></div></div>`;

  const issues = a.steps.flatMap((s) => (flags.get(s.id) ?? []).map((f) => ({ s, f })));
  const issueBox = issues.length
    ? `<section class="card an-issues"><h2 class="with-icon" style="margin-top:0">${icon("triangle-exclamation-point", 16)}見直すとよさそうな通</h2><ul>${issues
        .map(({ s, f }) => `<li><span class="pill ${FLAG_LABEL[f][0]}">${h(FLAG_LABEL[f][1])}</span><b>${s.position} 通目</b>「${h(s.subject || "（件名なし）")}」</li>`)
        .join("")}</ul><p class="muted" style="margin:8px 0 0">件名や本文の最初の数行、リンクの位置、送るタイミングを変えてみて、次の期間で比べてください。</p></section>`
    : a.steps.some((s) => s.sent > 0)
      ? `<section class="card an-issues ok"><p style="margin:0">${icon("circle-check", 16)} 目立って反応が落ちている通はありません。</p></section>`
      : "";

  const first = a.steps[0]?.sent ?? 0;
  const maxClick = Math.max(0.1, ...a.steps.map((s) => rate(s.clicked, s.sent)));
  const maxUnsub = Math.max(0.01, ...a.steps.map((s) => rate(s.unsubscribed, s.sent)));
  const has = (s: StepStats, f: Flag) => (flags.get(s.id) ?? []).includes(f);

  const reach = barChart({
    title: "届いた人",
    note: "各通を送った数。進行中の人がいるため、後半の通ほど少なく見えます。",
    steps: a.steps,
    value: (s) => s.sent,
    text: (s) => `${s.sent}${first > 0 && s.position > 1 ? `（${pctText(s.sent, first)}）` : ""}`,
    tip: (s) => `${s.position} 通目：送信 ${s.sent}、バウンス ${s.bounced}、苦情 ${s.complained}`,
    scale: Math.max(1, ...a.steps.map((s) => s.sent)),
    color: "var(--chart-2)",
    flagged: (s) => has(s, "big-drop"),
  });
  const clicks = barChart({
    title: "クリック率",
    note: "人がリンクを押した割合（ボットは除く）。反応を見るときはこれを主に使います。",
    steps: a.steps,
    value: (s) => rate(s.clicked, s.sent),
    text: (s) => pctText(s.clicked, s.sent),
    tip: (s) => `${s.position} 通目：クリック ${s.clicked} / 送信 ${s.sent}`,
    scale: maxClick,
    color: "var(--chart-1)",
    flagged: (s) => has(s, "low-click"),
  });
  const unsubs = barChart({
    title: "配信停止率",
    note: "この通を最後に受け取ってから 7 日以内に配信停止した人の割合。",
    steps: a.steps,
    value: (s) => rate(s.unsubscribed, s.sent),
    text: (s) => `${pctText(s.unsubscribed, s.sent)}（${s.unsubscribed} 人）`,
    tip: (s) => `${s.position} 通目：配信停止 ${s.unsubscribed} / 送信 ${s.sent}`,
    scale: maxUnsub,
    color: "var(--chart-4)",
    flagged: (s) => has(s, "unsub-warn") || has(s, "unsub-bad"),
  });

  const table = `<section class="card"><h2 style="margin-top:0">数値の一覧</h2><div class="wrap"><table class="an-table"><tr><th>通</th><th>件名</th><th>送信</th><th>開封率（目安）</th><th>クリック率</th><th>配信停止</th><th>バウンス</th><th>苦情</th></tr>${a.steps
    .map(
      (s) => `<tr><td>${s.position}</td><td>${h(s.subject || "（件名なし）")}</td><td>${s.sent}</td><td>${pct(s.opened, s.sent)}</td><td>${pct(s.clicked, s.sent)}</td><td>${s.unsubscribed}</td><td>${s.bounced}</td><td>${s.complained}</td></tr>`,
    )
    .join("")}</table></div>
<p class="muted" style="margin:8px 0 0">開封は、メールアプリが自動で画像を読み込むと数えられないことや、逆に多く数えられることがあるため目安です。</p></section>`;

  const routes = a.routes.length
    ? `<section class="card"><h2 style="margin-top:0">登録経路別</h2><p class="muted" style="margin:0 0 8px">このシナリオのフォームから入った人を、登録経路ごとに数えています（<a href="/admin/routes">登録経路</a>）。</p>
<div class="wrap"><table><tr><th>経路</th><th>入った人</th><th>完了</th><th>クリックした人</th><th>配信停止</th></tr>${a.routes
        .map(
          (r) => `<tr><td>${r.route ? h(r.route) : '<span class="muted">経路なし</span>'}</td><td>${r.entered}</td><td>${r.completed}（${pct(r.completed, r.entered)}）</td><td>${r.clicked}（${pct(r.clicked, r.entered)}）</td><td>${r.unsubscribed}（${pct(r.unsubscribed, r.entered)}）</td></tr>`,
        )
        .join("")}</table></div></section>`
    : "";

  return `<style>
.an-kpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3);margin-bottom:var(--space-4)}
@media (max-width:900px){.an-kpi{grid-template-columns:repeat(2,minmax(0,1fr))}}
.an-kpi .stat b small{font-size:14px;color:var(--ink-muted);font-weight:500}
.an-chart .an-row{display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr) 110px;gap:var(--space-3);align-items:center;padding:6px 0;border-radius:var(--radius-sm)}
.an-chart .an-row.flagged{background:var(--warning-soft);padding-left:var(--space-2);padding-right:var(--space-2)}
.an-label{display:flex;align-items:center;gap:var(--space-2);min-width:0;font-size:13px}
.an-num{flex:none;width:22px;height:22px;border-radius:50%;background:var(--surface-sunken);border:1px solid var(--line);display:grid;place-items:center;font:600 12px/1 var(--font-sans)}
.an-subj{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-track{height:12px;background:var(--surface-sunken);border-radius:var(--radius-pill);overflow:hidden}
.an-track span{display:block;height:100%;border-radius:0 4px 4px 0}
.an-val{font:500 13px/1 var(--font-sans);font-variant-numeric:tabular-nums;color:var(--ink);text-align:right}
.an-issues ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:var(--space-2)}
.an-issues li{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);font-size:14px}
.an-issues.ok p{display:flex;align-items:center;gap:var(--space-2);color:var(--success)}
.an-table td{white-space:normal}
@media (max-width:700px){.an-chart .an-row{grid-template-columns:minmax(0,1fr) 90px}.an-chart .an-track{grid-column:1 / -1;order:3}}
</style>
${period}${kpi}${issueBox}${reach}${clicks}${unsubs}${table}${routes}`;
}

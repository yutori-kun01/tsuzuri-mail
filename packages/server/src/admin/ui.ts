import { escapeHtml } from "@tsuzuri/core";
import { ADMIN_FONTS_LINK, BRAND, FAVICON_LINK, logoMark, TOKENS_CSS } from "../ui/theme.js";
import { icon, type IconName } from "./icons.js";

/** HTML に埋め込む値は必ずこれを通す */
export const h = (v: unknown): string => escapeHtml(v === null || v === undefined ? "" : String(v));

/** 管理画面の CSP（スクリプト・接続は自分のページだけ。Web フォントは Google Fonts のみ許可） */
export const ADMIN_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'";

/** サイドバーの並び（デザインシステムの Sidebar に合わせて、配信・読者・設定のまとまりで分ける） */
const NAV: (string | [string, string, IconName])[] = [
  ["/admin", "ホーム", "house"],
  "配信",
  ["/admin/broadcasts", "一斉配信", "send"],
  ["/admin/sequences", "シナリオ", "workflow"],
  ["/admin/automations", "自動化", "zap"],
  ["/admin/logs", "配信ログ", "scroll-text"],
  "読者",
  ["/admin/readers", "読者", "users"],
  ["/admin/forms", "フォーム", "file-input"],
  ["/admin/routes", "登録経路", "split"],
  ["/admin/topics", "配信の種類", "layers"],
  ["/admin/tags", "タグ", "tag"],
  "設定",
  ["/admin/variables", "置き換え文字", "braces"],
  ["/admin/footers", "フッター", "panel-bottom"],
  ["/admin/domains", "送信ドメイン", "globe"],
  ["/admin/settings", "設定", "settings"],
];

/**
 * デザインシステム「tsuzuri」の部品（components/bundle.css）を、管理画面の既存のクラス名に当てたもの。
 * .card = Panel、.stat = Stat、.pill = Badge、button = Button、table = DataTable、label/input = Field。
 */
const STYLE = `${TOKENS_CSS}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--canvas);color:var(--ink);font:400 14px/22px var(--font-sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
:focus-visible{outline:none;box-shadow:var(--shadow-focus);border-radius:var(--radius-sm)}
.layout{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100%}
.sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--surface);border-right:1px solid var(--line);padding:var(--space-4) var(--space-3);display:flex;flex-direction:column;gap:2px}
.brand{font:600 16px/24px var(--font-sans);color:var(--ink);padding:var(--space-2) var(--space-3) var(--space-4);letter-spacing:-.01em}
.navgroup{color:var(--ink-muted);font:500 11px/16px var(--font-sans);letter-spacing:.06em;padding:var(--space-4) var(--space-3) var(--space-1)}
.navitem{display:flex;align-items:center;height:34px;padding:0 var(--space-3);border-radius:var(--radius-sm);color:var(--ink);text-decoration:none;font-weight:500;white-space:nowrap}
.navitem:hover{background:var(--surface-sunken)}
.navitem[aria-current="page"]{background:var(--accent-soft);color:var(--accent)}
.sidebar form{margin-top:auto;padding-top:var(--space-4)}
.sidebar form button{width:100%}
main{min-width:0;padding:var(--space-8) var(--space-8) 64px;max-width:1184px;width:100%}
@media (max-width:900px){
  .layout{grid-template-columns:minmax(0,1fr)}
  .sidebar{position:sticky;top:0;height:auto;z-index:2;flex-direction:row;align-items:center;overflow-x:auto;padding:var(--space-2) max(var(--space-4),env(safe-area-inset-right,0px)) var(--space-2) max(var(--space-4),env(safe-area-inset-left,0px));border-right:0;border-bottom:1px solid var(--line);gap:var(--space-1)}
  .brand{padding:0 var(--space-3) 0 0}
  .navgroup{display:none}
  .sidebar form{margin:0 0 0 auto;padding:0}
  main{padding:var(--space-6) max(var(--space-4),env(safe-area-inset-right,0px)) 64px max(var(--space-4),env(safe-area-inset-left,0px))}
}
h1{font:600 20px/28px var(--font-sans);margin:0 0 var(--space-6);text-wrap:balance;display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}
h2{font:600 15px/22px var(--font-sans);margin:var(--space-8) 0 var(--space-3)}
.card h2:first-child{margin-top:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-6);margin-bottom:var(--space-4)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:var(--space-4)}
.grid.kpi{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:640px){.grid.kpi{grid-template-columns:repeat(2,minmax(0,1fr))}}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-4);display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:var(--space-1);min-width:0}
.stat b{display:block;font:600 28px/36px var(--font-sans);font-variant-numeric:tabular-nums}
.stat span{color:var(--ink-muted);font:500 12px/16px var(--font-sans);letter-spacing:.02em}
.wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md)}
table{width:100%;border-collapse:collapse;background:var(--surface)}
.wrap>table{border:0}
th,td{text-align:left;padding:var(--space-3);border-bottom:1px solid var(--line);vertical-align:middle;font-size:14px}
.wrap td{white-space:nowrap}.wrap td.muted{white-space:normal;min-width:200px}
th{background:var(--surface-sunken);color:var(--ink-muted);font:500 12px/16px var(--font-sans);letter-spacing:.02em;padding:var(--space-2) var(--space-3);white-space:nowrap}
tr:last-child td{border-bottom:0}
tbody tr:hover td,tr:hover>td{background:var(--surface-sunken)}
td a{font-weight:500;text-decoration:none}td a:hover{text-decoration:underline}
.muted{color:var(--ink-muted);font-size:12px;line-height:18px}
p.muted{margin:0 0 var(--space-3)}
.pill{display:inline-flex;align-items:center;gap:var(--space-1);height:22px;padding:0 var(--space-2);border-radius:var(--radius-pill);border:1px solid var(--line);background:var(--surface-sunken);color:var(--ink-muted);font:500 12px/1 var(--font-sans);margin:2px 4px 2px 0;white-space:nowrap;vertical-align:middle}
.pill.good,.pill.warn,.pill.bad{border-color:transparent}
.pill.good::before,.pill.warn::before,.pill.bad::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.good{background:var(--success-soft);color:var(--success)}
.pill.warn{background:var(--warning-soft);color:var(--warning)}
.pill.bad{background:var(--danger-soft);color:var(--danger)}
label{display:block;color:var(--ink-muted);font:500 12px/16px var(--font-sans);letter-spacing:.02em;margin:var(--space-4) 0 var(--space-1)}
input[type=text],input[type=search],input[type=time],input[type=email],input[type=password],input[type=number],input[type=datetime-local],input[type=url],select,textarea{width:100%;height:36px;padding:0 var(--space-3);font:400 14px/22px var(--font-sans);border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:var(--shadow-focus)}
input[disabled],select[disabled],textarea[disabled]{background:var(--surface-sunken);color:var(--ink-muted)}
textarea{height:auto;min-height:280px;padding:var(--space-3);font-family:var(--font-mono);font-size:13px;line-height:20px;resize:vertical}
input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent)}
.row{display:flex;gap:var(--space-3);flex-wrap:wrap}.row>*{flex:1;min-width:180px}
.check{display:flex;gap:var(--space-2);align-items:center;color:var(--ink);font:400 14px/20px var(--font-sans);letter-spacing:0;margin:var(--space-2) var(--space-4) 0 0}
.checks{display:flex;flex-wrap:wrap}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1);height:36px;padding:0 var(--space-4);font:500 14px/1 var(--font-sans);border-radius:var(--radius-sm);border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer;text-decoration:none;white-space:nowrap}
button:hover,.btn:hover{filter:brightness(1.08)}
button.sub,.btn.sub{background:var(--surface);color:var(--accent);border-color:var(--line-strong)}
button.sub:hover,.btn.sub:hover{filter:none;background:var(--surface-sunken)}
button.danger{background:var(--surface);color:var(--danger);border-color:var(--danger)}
button.danger:hover{filter:none;background:var(--danger-soft)}
td button{height:28px;padding:0 var(--space-3);font-size:13px}
.actions{display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-4);align-items:center}
.flash{padding:var(--space-3) var(--space-4);border-radius:var(--radius-sm);margin-bottom:var(--space-4);background:var(--success-soft);color:var(--success);font-weight:500}
.flash.error{background:var(--danger-soft);color:var(--danger)}
iframe.preview{width:100%;height:640px;border:1px solid var(--line);border-radius:var(--radius-md);background:#fff}
code{font-family:var(--font-mono);font-size:13px;background:var(--surface-sunken);padding:1px 4px;border-radius:4px}
.inline{display:inline}
.sender-box{margin-top:var(--space-4);border-top:1px solid var(--line);padding-top:var(--space-3)}.sender-box summary{cursor:pointer;color:var(--ink-muted);font-size:13px}
.sender-box code{font-family:var(--font-mono);font-size:12px}
dl{margin:0}
.login{min-height:100%;display:grid;place-items:center;padding:var(--space-6) var(--space-4)}
.login .card{width:100%;max-width:400px}
.login .brand{padding:0;margin-bottom:var(--space-1);font-size:20px}

/* ---- SaaS レイアウトの部品 ---- */
.tier-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-3)}
.tier-list li{display:grid;grid-template-columns:96px minmax(0,1fr) 48px;align-items:center;gap:var(--space-3)}
.tier-list a{text-decoration:none}
.tier-list b{text-align:right;font-variant-numeric:tabular-nums}
.bar-track{height:8px;border-radius:999px;background:var(--surface-sunken);overflow:hidden}
.bar-track span{display:block;height:100%;background:var(--accent);border-radius:999px}
.flash{display:flex;align-items:center;gap:var(--space-2)}

.icon{flex:none;display:block}
.navitem{gap:var(--space-3)}
.navitem .icon{color:var(--ink-muted)}
.navitem[aria-current="page"] .icon{color:var(--accent)}
.brand{display:flex;align-items:center;gap:var(--space-2)}
.sidebar form button{gap:var(--space-2)}
.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-4);margin:0 0 var(--space-6);flex-wrap:wrap}
.page-head h1{margin:0}
.page-head .desc{margin:var(--space-1) 0 0;color:var(--ink-muted);font-size:14px;max-width:62ch}
.page-head .head-actions{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center}
.back{display:inline-flex;align-items:center;gap:var(--space-1);color:var(--ink-muted);text-decoration:none;font-size:13px;margin-bottom:var(--space-2)}
.back:hover{color:var(--accent)}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:var(--space-2);padding:var(--space-8) var(--space-6);background:var(--surface);border:1px dashed var(--line-strong);border-radius:var(--radius-md);color:var(--ink-muted)}
.empty .empty-icon{width:44px;height:44px;border-radius:12px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;margin-bottom:var(--space-1)}
.empty b{color:var(--ink);font-size:15px}
.empty p{margin:0;max-width:44ch}
.empty .btn,.empty button{margin-top:var(--space-2)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-4);margin-bottom:var(--space-6)}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-4) var(--space-4) var(--space-3);display:flex;flex-direction:column;gap:var(--space-2);min-width:0}
.kpi-top{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)}
.kpi-label{color:var(--ink-muted);font:500 12px/16px var(--font-sans);letter-spacing:.02em}
.kpi-icon{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.kpi.warn .kpi-icon{background:var(--warning-soft);color:var(--warning)}
.kpi.bad .kpi-icon{background:var(--danger-soft);color:var(--danger)}
.kpi.good .kpi-icon{background:var(--success-soft);color:var(--success)}
.kpi-value{font:600 28px/34px var(--font-sans);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.kpi-hint{color:var(--ink-muted);font-size:12px;line-height:18px}
.kpi.warn .kpi-value{color:var(--warning)}.kpi.bad .kpi-value{color:var(--danger)}
.spark{display:block;width:100%;height:36px}
.spark rect{fill:var(--accent);opacity:.75}
.spark rect.zero{fill:var(--line);opacity:1}
.two{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:var(--space-4);align-items:start}
@media (max-width:1100px){.two{grid-template-columns:minmax(0,1fr)}}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin:0 0 var(--space-4)}
.card-head h2{margin:0}
.card-head a{font-size:13px;text-decoration:none;font-weight:500}
.chart{display:block;width:100%;height:auto}
.chart .bar{fill:var(--accent)}
.chart .bar2{fill:var(--accent-soft);stroke:var(--accent);stroke-width:1}
.chart .axis{fill:var(--ink-muted);font:400 11px var(--font-mono)}
.chart .grid{stroke:var(--line);stroke-width:1}
.legend{display:flex;gap:var(--space-4);color:var(--ink-muted);font-size:12px;margin-top:var(--space-2)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px;background:var(--accent)}
.legend i.soft{background:var(--accent-soft);border:1px solid var(--accent)}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-2)}
.steps li{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) var(--space-3);border-radius:var(--radius-sm);border:1px solid var(--line)}
.steps li.done{color:var(--ink-muted)}
.steps li.done .label{text-decoration:line-through}
.steps .check-icon{color:var(--line-strong)}
.steps li.done .check-icon{color:var(--success)}
.steps li a{margin-left:auto;font-size:13px;text-decoration:none;font-weight:500;white-space:nowrap}
.progress{height:6px;border-radius:999px;background:var(--surface-sunken);overflow:hidden;margin:0 0 var(--space-4)}
.progress span{display:block;height:100%;background:var(--accent);border-radius:999px}
.tabs{display:flex;gap:var(--space-1);border-bottom:1px solid var(--line);margin:0 0 var(--space-4);overflow-x:auto}
.tabs a{display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);color:var(--ink-muted);text-decoration:none;font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a[aria-current="page"]{color:var(--accent);border-bottom-color:var(--accent)}
.tabs .count{font:400 12px/1 var(--font-mono);background:var(--surface-sunken);padding:3px 6px;border-radius:999px}
.toolbar{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;margin-bottom:var(--space-4)}
.search{position:relative;flex:1;min-width:220px}
.search .icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-muted);pointer-events:none}
.search input{padding-left:34px}
.toolbar select{width:auto;min-width:140px}
.avatar{width:28px;height:28px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:inline-grid;place-items:center;font:600 12px/1 var(--font-sans);flex:none}
.who{display:flex;align-items:center;gap:var(--space-2)}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,440px);gap:var(--space-4);align-items:start}
@media (max-width:1180px){.split{grid-template-columns:minmax(0,1fr)}}
.sticky{position:sticky;top:var(--space-4)}
.phone{border:1px solid var(--line);border-radius:16px;background:var(--surface-sunken);padding:var(--space-2)}
.phone-bar{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);font-size:12px;color:var(--ink-muted)}
.phone-bar b{color:var(--ink);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.phone iframe{width:100%;height:560px;border:0;border-radius:10px;background:#fff;display:block}
.count-box{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-3) var(--space-4);border-radius:var(--radius-sm);background:var(--accent-soft);color:var(--accent);font-weight:500;margin-top:var(--space-4)}
.count-box b{font:600 18px/1 var(--font-sans);font-variant-numeric:tabular-nums}
.htmx-request .count-box,.count-box.htmx-request{opacity:.6}
.toast{position:fixed;right:max(var(--space-6),env(safe-area-inset-right,0px));bottom:max(var(--space-6),env(safe-area-inset-bottom,0px));z-index:50;display:flex;align-items:center;gap:var(--space-2);max-width:min(440px,calc(100vw - 32px));padding:var(--space-3) var(--space-4);border-radius:var(--radius-md);background:var(--ink);color:var(--surface);font-weight:500;box-shadow:0 8px 24px rgba(10,20,22,.18)}
.toast.error{background:var(--danger);color:#fff}
.toast button{height:auto;padding:2px;border:0;background:transparent;color:inherit;margin-left:var(--space-2)}
.toast.hide{opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}

/* ---- ブランド DNA（ムードボード）に合わせた上書き ---- */
body{font-size:var(--text-note)}
h1{font:600 var(--text-h2)/1.35 var(--font-sans);letter-spacing:-.01em}
h2{font:600 16px/24px var(--font-sans)}
.card,.kpi,.wrap,.empty{box-shadow:var(--shadow-card)}
.card{border-radius:var(--radius-md)}
.sidebar{padding:var(--space-6) var(--space-3) var(--space-4)}
.brand{gap:10px;padding:0 var(--space-3) var(--space-6);text-decoration:none}
.logo-mark{flex:none;display:block;border-radius:22%}
.wordmark{font:600 18px/1 var(--font-serif);color:var(--ink);letter-spacing:.01em}
.navitem{height:38px;border-radius:8px}
.navitem[aria-current="page"]{background:var(--accent-soft);color:var(--ink);font-weight:600}
.pill.info{background:var(--info-soft);color:var(--info);border-color:transparent}
.pill.info::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.kpi{padding:var(--space-4) var(--space-4) var(--space-3)}
.kpi-top{justify-content:flex-start;gap:var(--space-2)}
.kpi-icon{width:auto;height:auto;background:none!important}
.kpi-value{font-size:26px;line-height:32px}
.kpi-row{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-3)}
.delta{display:inline-flex;align-items:center;gap:2px;font:600 12px/16px var(--font-sans);font-variant-numeric:tabular-nums;white-space:nowrap}
.delta.up{color:var(--success)}.delta.down{color:var(--danger)}.delta.flat{color:var(--ink-muted);font-weight:400}
.spark{width:96px;max-width:48%;height:32px;flex:0 1 auto;min-width:0}
.kpi-row>div{min-width:0}
.spark .area{fill:var(--accent-2);opacity:.28}
.spark .line{fill:none;stroke:var(--accent-2);stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round}
.chart .s1{fill:none;stroke:var(--chart-1);stroke-width:2.25;stroke-linejoin:round}
.chart .s2{fill:none;stroke:var(--chart-2);stroke-width:2;stroke-linejoin:round}
.chart .a1{fill:var(--chart-1);opacity:.10}
.chart .d1{fill:var(--surface);stroke:var(--chart-1);stroke-width:1.75}
.chart .d2{fill:var(--surface);stroke:var(--chart-2);stroke-width:1.5}
.legend i{border-radius:50%;width:8px;height:8px}
.legend i.c1{background:var(--chart-1)}.legend i.c2{background:var(--chart-2)}
.card-head .legend{margin:0}
.donut-wrap{display:flex;align-items:center;gap:var(--space-6);flex-wrap:wrap}
.donut{flex:none}
.donut .center{fill:var(--ink);font:600 22px var(--font-sans)}
.donut .center-sub{fill:var(--ink-muted);font:500 11px var(--font-sans)}
.donut-legend{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-2);flex:1;min-width:160px}
.donut-legend li{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;align-items:center;gap:var(--space-2)}
.donut-legend i{width:10px;height:10px;border-radius:50%}
.donut-legend a{color:var(--ink);text-decoration:none}
.donut-legend a:hover{color:var(--accent)}
.donut-legend b,.donut-legend span{font-variant-numeric:tabular-nums;text-align:right}
.donut-legend span{color:var(--ink-muted);min-width:44px}
.setup{display:flex;align-items:center;gap:var(--space-6);flex-wrap:wrap}
.setup h2{margin:0 0 var(--space-2)}
.setup .steps{flex-direction:row;flex-wrap:wrap;gap:var(--space-2) var(--space-4)}
.setup .steps li{border:0;padding:0;gap:var(--space-2)}
.setup .steps li.done .label{text-decoration:none}
.setup .steps a.label{color:var(--ink);text-decoration:none;font-weight:500}
.setup .steps a.label:hover{color:var(--accent)}
.ring{flex:none}
.ring .track{fill:none;stroke:var(--surface-sunken);stroke-width:6}
.ring .bar{fill:none;stroke:var(--accent);stroke-width:6;stroke-linecap:round}
.ring text{fill:var(--ink);font:600 15px var(--font-sans)}
.range{display:inline-flex;align-items:center;gap:var(--space-2);height:36px;padding:0 var(--space-2) 0 var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink-muted)}
.range select{border:0;height:32px;padding:0 var(--space-1);width:auto;box-shadow:none!important;background:transparent}
.notice{border-color:var(--warning-soft);background:linear-gradient(var(--warning-soft),var(--surface) 70%)}
.notice.ok{border-color:var(--success-soft);background:linear-gradient(var(--success-soft),var(--surface) 70%)}
.notice h2{display:flex;align-items:center;gap:var(--space-2);color:var(--warning)}
.notice.ok h2{color:var(--success)}
.notice ul{margin:0;padding-left:1.2em;display:grid;gap:var(--space-2)}
.mail-cell{display:flex;align-items:center;gap:var(--space-2)}
h2.with-icon{display:flex;align-items:center;gap:var(--space-2)}
.tag-picker{display:flex;flex-wrap:wrap;gap:var(--space-2);padding:var(--space-2) 0}
.chip-check{display:inline-flex;margin:0;cursor:pointer;color:var(--ink);font:400 13px/20px var(--font-sans);letter-spacing:0}
.chip-check input{position:absolute;opacity:0;width:1px;height:1px}
.chip-check span{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-pill);background:var(--surface)}
.chip-check small{font:400 11px/1 var(--font-mono);color:var(--ink-muted)}
.chip-check input:checked+span{background:var(--accent-soft);border-color:var(--accent);color:var(--ink);font-weight:500}
.chip-check input:checked+span::before{content:"✓";color:var(--accent);font-weight:600}
.chip-check input:focus-visible+span{box-shadow:var(--shadow-focus)}
.chip-check input:disabled+span{opacity:.6;cursor:default}
input.new-tag{margin-top:var(--space-1)}
.topic-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:var(--space-2);margin:var(--space-1) 0}
.topic-card{display:block;margin:0;cursor:pointer;letter-spacing:0}
.topic-card input{position:absolute;opacity:0;width:1px;height:1px}
.topic-card span{display:flex;flex-direction:column;gap:2px;height:100%;padding:var(--space-2) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink);font:400 13px/20px var(--font-sans)}
.topic-card small{color:var(--ink-muted);font-size:12px;line-height:16px}
.topic-card input:checked+span{border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)}
.topic-card input:focus-visible+span{box-shadow:var(--shadow-focus)}
.bulk-bar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);margin:0 0 var(--space-2)}
.bulk-bar input[type=text]{width:auto;min-width:220px;flex:0 1 280px}
.pair{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-3);padding:var(--space-3) 0;border-top:1px solid var(--line)}
.pair:first-of-type{border-top:0;padding-top:0}
.status-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-3)}
details>summary{cursor:pointer;margin:var(--space-4) 0 var(--space-1)}
.rule{padding:var(--space-4) var(--space-6)}
.rule.off{opacity:.6}
.rule-line{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.rule-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:var(--radius-sm);font-weight:500}
.rule-chip.when{background:var(--warning-soft);color:var(--warning)}
.rule-chip.then{background:var(--accent-soft);color:var(--accent)}
.rule-arrow{color:var(--ink-muted);display:inline-flex}
.rule-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2);margin-top:var(--space-3)}
.rule-build{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:var(--space-4);align-items:start}
.rule-build .rule-arrow.big{margin-top:42px}
@media (max-width:900px){.rule-build{grid-template-columns:minmax(0,1fr)}.rule-build .rule-arrow.big{margin:0;transform:rotate(90deg)}}
.opt-box{padding:var(--space-3) var(--space-4);border:1px solid var(--line);border-radius:var(--radius-sm);margin-top:var(--space-2)}
.sect{display:block;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface);margin-bottom:var(--space-4);overflow:hidden}
.sect-head{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-3) var(--space-4);background:var(--surface-sunken);border-bottom:1px solid var(--line);font-weight:600;font-size:15px;color:var(--ink)}
.sect-head .icon{color:var(--accent)}
details.sect>summary.sect-head{cursor:pointer;list-style:none}details.sect>summary.sect-head::-webkit-details-marker{display:none}
details.sect>summary.sect-head::after{content:"";margin-left:var(--space-2);width:8px;height:8px;border-right:2px solid var(--ink-muted);border-bottom:2px solid var(--ink-muted);transform:rotate(45deg);transition:transform .15s}
details.sect[open]>summary.sect-head::after{transform:rotate(-135deg)}
details.sect:not([open])>summary.sect-head{border-bottom:0}
.sect-num{flex:none;width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font:600 12px/1 var(--font-sans)}
.sect-note{margin-left:auto;font:500 12px/1 var(--font-sans);color:var(--ink-muted);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-pill);padding:4px 10px}
.sect-body{padding:var(--space-1) var(--space-4) var(--space-4)}
.opt-card{border-radius:var(--radius-sm);padding:var(--space-3) var(--space-4);margin-top:var(--space-3);border-left:4px solid}
.opt-card label:first-of-type{margin-top:var(--space-2)}
.opt-card.ab{background:var(--info-soft);border-color:var(--info)}.opt-card.ab .opt-title{color:var(--info)}
.opt-card.time{background:var(--success-soft);border-color:var(--success)}.opt-card.time .opt-title{color:var(--success)}
.opt-title{display:flex;align-items:center;gap:var(--space-2);font-weight:600}
.opt-note{margin:var(--space-2) 0 0;font-size:12px;line-height:18px;color:var(--ink-muted)}
details.acc{margin-top:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-sm)}
details.acc>summary{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);cursor:pointer;list-style:none;font-size:13px;font-weight:500;color:var(--ink-muted)}
details.acc>summary::-webkit-details-marker{display:none}
details.acc>summary::after{content:"";margin-left:auto;width:7px;height:7px;border-right:2px solid var(--ink-muted);border-bottom:2px solid var(--ink-muted);transform:rotate(45deg);transition:transform .15s}
details.acc[open]>summary::after{transform:rotate(-135deg)}
.acc-body{padding:0 var(--space-3) var(--space-3)}
.opt-box label:first-child{margin-top:0}
.flow{display:flex;flex-direction:column;align-items:center;gap:var(--space-1)}
.flow-end{width:100%;max-width:560px;padding:var(--space-3) var(--space-4);border:1px dashed var(--line-strong);border-radius:var(--radius-md);background:var(--surface-sunken);display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.flow-chips{display:flex;flex-wrap:wrap;gap:var(--space-2);width:100%}
.flow-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--radius-pill);background:var(--surface);border:1px solid var(--line);color:var(--ink);font-size:13px;text-decoration:none}
a.flow-chip:hover{border-color:var(--accent)}
.flow-arrow{color:var(--line-strong);display:flex}
.flow-time{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-muted)}
.flow-node{width:100%;max-width:560px;display:flex;gap:var(--space-3);align-items:flex-start;padding:var(--space-3) var(--space-4);border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface);color:var(--ink);text-decoration:none;box-shadow:var(--shadow-card)}
.flow-node:hover{border-color:var(--accent)}
.flow-node span:last-child{display:flex;flex-direction:column;gap:2px;min-width:0}
.flow-node .flow-body{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}.flow-node .flow-body a{color:var(--ink);text-decoration:none}.flow-node .flow-body a:hover{color:var(--accent)}
.flow-actions{display:flex;gap:var(--space-1);align-items:center;flex:none}.flow-actions .btn,.flow-actions button{height:30px;padding:0 var(--space-2);font-size:13px}
.flow-add{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px dashed var(--accent);border-radius:var(--radius-pill);color:var(--accent);font-weight:500;text-decoration:none;font-size:13px;background:var(--surface)}.flow-add:hover{background:var(--accent-soft)}
dialog.modal{width:min(560px,calc(100vw - 32px));padding:var(--space-6);border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-card)}
dialog.modal::backdrop{background:color-mix(in srgb,var(--brand-deep) 45%,transparent)}
.modal-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-2)}.modal-head h2{margin:0}
dialog.modal .row{flex-direction:column;gap:0}dialog.modal .actions{justify-content:flex-end}
.add-step>summary{display:flex;align-items:center;gap:var(--space-2);cursor:pointer;font-weight:600;font-size:16px;list-style:none}.add-step>summary::-webkit-details-marker{display:none}.add-step[open]>summary{margin-bottom:var(--space-3)}
.fedit{display:grid;grid-template-columns:176px minmax(0,1fr);gap:var(--space-4);align-items:start}
.fnav{position:sticky;top:var(--space-4);display:flex;flex-direction:column;gap:2px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-2)}
.fnav a{display:flex;align-items:center;gap:var(--space-2);height:36px;padding:0 var(--space-3);border-radius:var(--radius-sm);color:var(--ink);text-decoration:none;font-weight:500}
.fnav a:hover{background:var(--surface-sunken)}
.fnav a[aria-current="page"]{background:var(--accent-soft);color:var(--accent)}
.fnav .count{margin-left:auto;font:500 12px/1 var(--font-sans);color:var(--ink-muted)}
.fsave{position:sticky;bottom:0;background:var(--canvas);padding:var(--space-3) 0;border-top:1px solid var(--line);margin-top:var(--space-2)}
@media (max-width:860px){.fedit{grid-template-columns:minmax(0,1fr)}.fnav{position:static;flex-direction:row;flex-wrap:wrap}}
.impact{margin:0 0 var(--space-3);padding-left:1.2em;display:grid;gap:var(--space-1);font-size:13px}
.flow-node small{color:var(--ink-muted);font-size:12px}
.flow-num{flex:none;width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font:600 13px/1 var(--font-sans)}
.flow-cond{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--warning)}
.ph-chips{display:flex;flex-wrap:wrap;gap:var(--space-1);margin-top:var(--space-2)}
button.chip{height:auto;min-height:28px;padding:2px var(--space-2);border:1px solid var(--line);background:var(--surface-sunken);color:var(--ink);font:400 12px/18px var(--font-mono);border-radius:var(--radius-pill);gap:var(--space-1)}
button.chip span{font-family:var(--font-sans);color:var(--ink-muted)}
button.chip:hover{filter:none;border-color:var(--accent)}
.timing{display:flex;flex-direction:column;gap:var(--space-2);margin:0 0 var(--space-2)}
.timing .check{flex-wrap:wrap;margin:0;padding:var(--space-2) var(--space-3);border:1px solid var(--line);border-radius:var(--radius-sm);gap:var(--space-2)}
.timing .check:has(input[type=radio]:checked){border-color:var(--accent);background:var(--accent-soft)}
input.inline-num{width:88px}
select.inline-sel{width:auto}
input.inline-time{width:120px}
h2.with-icon .icon{color:var(--accent)}
.mail-cell .icon{color:var(--ink-muted)}
.two.wide{grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:stretch}
.two.wide>.card{margin-bottom:var(--space-4)}
@media (max-width:1100px){.two.wide{grid-template-columns:minmax(0,1fr)}}
.login .card{max-width:420px;padding:var(--space-8)}
.login-brand{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-4)}
.login-brand .wordmark{font-size:24px}
.tagline{margin:0;color:var(--ink-muted);font-size:13px;line-height:20px}
.promise{font:600 15px/1.8 var(--font-sans);color:var(--ink);margin:var(--space-4) 0 var(--space-2);letter-spacing:.04em}
.promise::after{content:"";display:block;width:96px;height:2px;border-radius:2px;background:var(--accent-2);margin-top:var(--space-2)}
/* スマホ：上部のバー＋開くメニュー＋下部のタブ */
.topbar,.tabbar{display:none}
@media (max-width:900px){
  .sidebar{display:none}
  .topbar{display:flex;position:sticky;top:0;z-index:20;align-items:center;justify-content:space-between;height:56px;padding:0 max(var(--space-4),env(safe-area-inset-right,0px)) 0 max(var(--space-4),env(safe-area-inset-left,0px));background:var(--surface);border-bottom:1px solid var(--line)}
  .topbar .brand{padding:0}
  .menu summary{list-style:none;display:grid;place-items:center;width:40px;height:40px;border-radius:var(--radius-sm);cursor:pointer;color:var(--ink)}
  .menu summary::-webkit-details-marker{display:none}
  .menu[open] summary{background:var(--surface-sunken)}
  .menu nav{position:absolute;left:0;right:0;top:56px;background:var(--surface);border-bottom:1px solid var(--line);box-shadow:0 12px 24px rgba(12,37,48,.12);padding:var(--space-2) var(--space-4) var(--space-4);display:flex;flex-direction:column;gap:2px;max-height:calc(100vh - 56px);overflow-y:auto}
  .menu nav form{margin-top:var(--space-3)}.menu nav form button{width:100%;gap:var(--space-2)}
  .tabbar{display:grid;grid-template-columns:repeat(4,1fr);position:fixed;left:0;right:0;bottom:0;z-index:20;background:var(--surface);border-top:1px solid var(--line);padding:6px 0 max(6px,env(safe-area-inset-bottom,0px))}
  .tabbar a{display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--ink-muted);text-decoration:none;font:500 11px/14px var(--font-sans);padding:4px 0}
  .tabbar a[aria-current="page"]{color:var(--accent)}
  main{padding-bottom:96px}
  h1{font-size:var(--text-h3)}
  .toast{bottom:84px}
}
/* スマホ：表をカード型に組み替える（列の見出しは各値の左に出す。stackTables() が data-label を付ける） */
@media (max-width:640px){
  table.stack,table.stack>tbody,table.stack>thead{display:block}
  table.stack tr.head-row,table.stack>thead{display:none}
  table.stack tr{display:block;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line)}
  table.stack tr:last-child{border-bottom:0}
  .wrap table.stack td,table.stack td{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);padding:3px 0;border:0;white-space:normal;min-width:0;text-align:right;overflow-wrap:anywhere}
  table.stack td::before{content:attr(data-label);flex:none;max-width:45%;color:var(--ink-muted);font:500 12px/18px var(--font-sans);text-align:left}
  table.stack td.primary,table.stack td[data-label=""]{justify-content:flex-start;text-align:left}
  table.stack td.primary::before,table.stack td[data-label=""]::before{content:none}
  table.stack td.primary{font-size:15px;padding-bottom:var(--space-2)}
  table.stack td.grip,table.stack td:empty{display:none}
  table.stack tr:hover>td{background:transparent}
  .wrap:has(table.stack){overflow-x:visible}
  .page-head .head-actions{width:100%}
  .row>*{min-width:100%}
  .toolbar select,.toolbar .search{min-width:0;flex:1 1 140px}
  .card{padding:var(--space-4)}
  iframe.preview{height:520px}
  .bulk-bar input[type=text]{min-width:0;flex:1 1 100%}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export interface PageOptions {
  title: string;
  active: string;
  body: string;
  flash?: { kind: "ok" | "error"; text: string } | undefined;
}

function head(title: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${h(title)}｜${BRAND.name}</title>${FAVICON_LINK}${ADMIN_FONTS_LINK}<style>${STYLE}</style>
<script src="/admin/assets/htmx.min.js" defer></script></head>`;
}

/** スマホ下部のタブ（4 つ）。どのページがどのタブに属すか */
const TABBAR: [string, string, IconName, string[]][] = [
  ["/admin", "ホーム", "house", ["/admin"]],
  ["/admin/broadcasts", "配信", "send", ["/admin/broadcasts", "/admin/sequences", "/admin/automations", "/admin/logs"]],
  ["/admin/readers", "読者", "users", ["/admin/readers", "/admin/forms", "/admin/routes", "/admin/topics", "/admin/tags"]],
  ["/admin/settings", "設定", "settings", ["/admin/variables", "/admin/footers", "/admin/domains", "/admin/settings"]],
];

function brandLink(id: string): string {
  return `<a class="brand" href="/admin">${logoMark(28, id)}<span class="wordmark">${h(BRAND.name)}</span></a>`;
}


/** スマホで表をカード型にするため、各セルに列の見出しを data-label として付ける（.no-stack の表は対象外） */
const STACK_SCRIPT = `<script>(function(){document.querySelectorAll('.wrap>table:not(.no-stack)').forEach(function(t){
var hr=null;t.querySelectorAll('tr').forEach(function(tr){if(!hr&&tr.querySelector('th')&&!tr.querySelector('td'))hr=tr});if(!hr)return;
var labels=[];hr.querySelectorAll('th').forEach(function(th){var n=th.colSpan||1;for(var i=0;i<n;i++)labels.push(th.textContent.trim())});
var first=labels.findIndex(function(l){return l!==''});hr.classList.add('head-row');t.classList.add('stack');
t.querySelectorAll('tr').forEach(function(tr){if(tr===hr)return;var i=0;Array.prototype.forEach.call(tr.children,function(td){if(td.tagName!=='TD')return;td.setAttribute('data-label',td.colSpan>1?'':(labels[i]||''));if(i===first&&td.colSpan===1)td.classList.add('primary');i+=td.colSpan||1})})})})();</script>`;

export function adminPage(o: PageOptions): string {
  const nav = NAV.map((item) =>
    typeof item === "string"
      ? `<div class="navgroup">${h(item)}</div>`
      : `<a class="navitem" href="${item[0]}"${o.active === item[0] ? ' aria-current="page"' : ""}>${icon(item[2], 18)}<span>${h(item[1])}</span></a>`,
  ).join("");
  const logout = `<form method="post" action="/admin/logout"><button class="sub" type="submit">${icon("log-out", 16)}ログアウト</button></form>`;
  const tabbar = TABBAR.map(
    ([href, label, ic, group]) =>
      `<a href="${href}"${group.includes(o.active) ? ' aria-current="page"' : ""}>${icon(ic, 22)}<span>${h(label)}</span></a>`,
  ).join("");
  // 完了・エラーの知らせは右下のトースト（完了は数秒で消える。エラーは閉じるまで残す）
  const toast = o.flash
    ? `<div class="toast${o.flash.kind === "error" ? " error" : ""}" role="${o.flash.kind === "error" ? "alert" : "status"}" id="toast">${icon(o.flash.kind === "error" ? "circle-x" : "circle-check", 18)}<span>${h(o.flash.text)}</span><button type="button" aria-label="閉じる" onclick="this.parentNode.remove()">${icon("x", 16)}</button></div>
<script>(function(){var t=document.getElementById("toast");if(!t)return;var u=new URL(location.href);u.searchParams.delete("ok");u.searchParams.delete("err");history.replaceState(null,"",u.pathname+(u.search||"")+u.hash);if(!t.classList.contains("error"))setTimeout(function(){t.classList.add("hide");setTimeout(function(){t.remove()},300)},4000)})();</script>`
    : "";
  return `${head(o.title)}
<body><header class="topbar">${brandLink("tz-m")}<details class="menu"><summary aria-label="メニュー">${icon("menu", 22)}</summary><nav aria-label="管理メニュー">${nav}${logout}</nav></details></header>
<div class="layout"><nav class="sidebar" aria-label="管理メニュー">${brandLink("tz-d")}${nav}
${logout}</nav>
<main>${o.body}</main></div>
<nav class="tabbar" aria-label="主なメニュー">${tabbar}</nav>${toast}${STACK_SCRIPT}</body></html>`;
}

/** ページの見出し（タイトル・説明・右上の操作・戻るリンク） */
export function pageHeader(o: { title: string; desc?: string; actions?: string; back?: [string, string]; badge?: string }): string {
  const back = o.back ? `<a class="back" href="${o.back[0]}">${icon("arrow-left", 14)}${h(o.back[1])}</a>` : "";
  return `<div class="page-head"><div>${back}<h1>${h(o.title)}${o.badge ?? ""}</h1>${o.desc ? `<p class="desc">${h(o.desc)}</p>` : ""}</div>${
    o.actions ? `<div class="head-actions">${o.actions}</div>` : ""
  }</div>`;
}

/** 何も無いときの案内（次にすることを 1 つ示す） */
export function emptyState(o: { icon: IconName; title: string; text: string; action?: string }): string {
  return `<div class="empty"><span class="empty-icon">${icon(o.icon, 22)}</span><b>${h(o.title)}</b><p>${h(o.text)}</p>${o.action ?? ""}</div>`;
}

/**
 * 小窓（作成フォームなど）。data-dialog="id" を付けたボタンで開く。
 * ページを開いたときに URL が #id なら最初から開く。
 */
export function modal(o: { id: string; title: string; body: string }): string {
  return `<dialog class="modal" id="${h(o.id)}" aria-labelledby="${h(o.id)}-title"><div class="modal-head"><h2 id="${h(o.id)}-title">${h(o.title)}</h2><button type="button" class="sub icon-only" data-close title="閉じる" aria-label="閉じる">${icon("x", 16)}</button></div>${o.body}</dialog>
<script>(function(){var d=document.getElementById(${JSON.stringify(o.id)});if(!d)return;function open(){d.showModal();var i=d.querySelector('input:not([type=hidden])');if(i)i.focus()}
document.querySelectorAll('[data-dialog=${JSON.stringify(o.id).slice(1, -1)}]').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();open()})});
d.querySelectorAll('[data-close]').forEach(function(b){b.addEventListener('click',function(){d.close()})});
d.addEventListener('click',function(e){if(e.target===d)d.close()});if(location.hash==='#'+d.id)open()})();</script>`;
}

/** HTML 形式の本文での置き換え文字の扱い（編集画面の注記） */
export const HTML_PLACEHOLDER_NOTE =
  '<p class="muted" style="margin:4px 0 0">HTML 形式では、登録済みの置き換え文字（%name%・%cancel%・置き換え文字の画面で作ったもの・%attr.キー%）だけを置き換えます。URL の %E3%81%82 や CSS の 100% などはそのまま送ります。</p>';

/** 主ボタン風のリンク（アイコン付き） */
export function linkButton(href: string, label: string, ic?: IconName, sub = false): string {
  return `<a class="btn${sub ? " sub" : ""}" href="${href}">${ic ? icon(ic, 16) : ""}${h(label)}</a>`;
}

/** 前の期間との差。null は比べられない（前の期間が 0 など） */
export function delta(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

/** 指標のカード（前の期間との差・小さな面グラフ付き） */
export function kpiCard(o: {
  label: string;
  value: string;
  hint?: string;
  icon: IconName;
  tone?: "good" | "warn" | "bad";
  spark?: number[];
  change?: { pct: number | null; upIsGood?: boolean; unit?: string; abs?: number };
}): string {
  let change = "";
  if (o.change) {
    const v = o.change.abs ?? o.change.pct;
    if (v === null || v === undefined) {
      change = `<span class="delta flat">前期間なし</span>`;
    } else {
      const up = v > 0.05, down = v < -0.05;
      const good = (o.change.upIsGood ?? true) ? up : down;
      const bad = (o.change.upIsGood ?? true) ? down : up;
      const cls = good ? "up" : bad ? "down" : "flat";
      const arrow = up ? "↑" : down ? "↓" : "→";
      const num = `${v > 0 ? "+" : ""}${v.toFixed(o.change.abs !== undefined ? 2 : 1)}${o.change.unit ?? "%"}`;
      change = `<span class="delta ${cls}" title="前の同じ長さの期間との比較">${arrow} ${h(num)}</span>`;
    }
  }
  return `<div class="kpi${o.tone ? ` ${o.tone}` : ""}"><div class="kpi-top"><span class="kpi-icon">${icon(o.icon, 18)}</span><span class="kpi-label">${h(o.label)}</span></div>
<div class="kpi-row"><div><div class="kpi-value">${h(o.value)}</div>${change}</div>${o.spark ? sparkline(o.spark) : ""}</div>${o.hint ? `<div class="kpi-hint">${h(o.hint)}</div>` : ""}</div>`;
}

function pathFor(values: number[], w: number, hgt: number, top: number, padT = 0, x0 = 0): [number, number][] {
  const n = values.length;
  return values.map((v, i) => [x0 + (n === 1 ? w / 2 : (i / (n - 1)) * w), padT + hgt * (1 - v / top)] as [number, number]);
}
const d = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

/** 日ごとの数の小さな面グラフ（値は相対） */
export function sparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  const pts = pathFor(values, 96, 26, max, 3);
  const area = `${d(pts)}L96,32L0,32Z`;
  return `<svg class="spark" viewBox="0 0 96 32" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"></path><path class="line" d="${d(pts)}"></path></svg>`;
}

/** 2 系列の日別の折れ線グラフ（例：送信数と新規登録）。labels は x 軸の文字 */
export function lineChart(o: { series: [number[], number[]]; labels: string[]; names: [string, string] }): string {
  const [a, b] = o.series;
  const n = a.length;
  const W = 640, H = 220, padL = 40, padR = 8, padB = 24, padT = 10;
  const max = Math.max(1, ...a, ...b);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top);
  const pw = W - padL - padR, ph = H - padT - padB;
  const grid = [0, 1, 2, 3, 4]
    .map((k) => step * k)
    .filter((v) => v <= top)
    .map((v) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"></line><text class="axis" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v).toLocaleString("ja-JP")}</text>`)
    .join("");
  const pa = pathFor(a, pw, ph, top, padT, padL);
  const pb = pathFor(b, pw, ph, top, padT, padL);
  const dots = (pts: [number, number][], vals: number[], cls: string, name: string) =>
    n <= 45
      ? pts.map(([x, yy], i) => `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}" r="2.5"><title>${h(o.labels[i])} ${h(name)} ${vals[i]}</title></circle>`).join("")
      : "";
  const every = Math.ceil(n / 7);
  const ticks = o.labels
    .map((l, i) => {
      const last = i === n - 1;
      if (!last && (i % every !== 0 || n - 1 - i < every / 2)) return "";
      const x = pa[i]![0];
      return `<text class="axis" x="${(last ? W - padR : x).toFixed(1)}" y="${H - 6}" text-anchor="${last ? "end" : i === 0 ? "start" : "middle"}">${h(l)}</text>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(o.names[0])}と${h(o.names[1])}の日別の推移">${grid}
<path class="a1" d="${d(pa)}L${pa[n - 1]![0].toFixed(1)},${y(0).toFixed(1)}L${padL},${y(0).toFixed(1)}Z"></path>
<path class="s2" d="${d(pb)}"></path><path class="s1" d="${d(pa)}"></path>${dots(pb, b, "d2", o.names[1])}${dots(pa, a, "d1", o.names[0])}${ticks}</svg>`;
}

/** 凡例（グラフの右上に置く） */
export function legend(names: [string, string]): string {
  return `<div class="legend"><span><i class="c1"></i>${h(names[0])}</span><span><i class="c2"></i>${h(names[1])}</span></div>`;
}

/** ドーナツ（区分の内訳など）。color は CSS 変数名 */
export function donut(o: { items: { label: string; value: number; color: string; href?: string }[]; center: string; sub: string }): string {
  const total = o.items.reduce((a, i) => a + i.value, 0);
  const R = 42, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = total
    ? o.items
        .filter((i) => i.value > 0)
        .map((i) => {
          const len = (i.value / total) * C;
          const seg = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="var(${i.color})" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"></circle>`;
          off += len;
          return seg;
        })
        .join("")
    : "";
  const legendHtml = o.items
    .map((i) => {
      const label = i.href ? `<a href="${i.href}">${h(i.label)}</a>` : h(i.label);
      return `<li><i style="background:var(${i.color})"></i>${label}<b>${i.value.toLocaleString("ja-JP")}</b><span>${total ? `${Math.round((i.value / total) * 100)}%` : "—"}</span></li>`;
    })
    .join("");
  return `<div class="donut-wrap"><svg class="donut" width="140" height="140" viewBox="0 0 120 120" role="img" aria-label="内訳"><circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--surface-sunken)" stroke-width="16"></circle>${arcs}
<text class="center" x="60" y="62" text-anchor="middle">${h(o.center)}</text><text class="center-sub" x="60" y="80" text-anchor="middle">${h(o.sub)}</text></svg><ul class="donut-legend">${legendHtml}</ul></div>`;
}

/** 進み具合の輪（はじめの準備など） */
export function ring(done: number, total: number): string {
  const R = 24, C = 2 * Math.PI * R;
  const len = total ? (done / total) * C : 0;
  return `<svg class="ring" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${total} 項目中 ${done} 項目完了"><circle class="track" cx="32" cy="32" r="${R}"></circle><circle class="bar" cx="32" cy="32" r="${R}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 32 32)"></circle><text x="32" y="37" text-anchor="middle">${done}/${total}</text></svg>`;
}

function niceStep(max: number): number {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  // 件数なので目盛りは整数（1 未満にしない）
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
}

/** 名前やアドレスの頭文字の丸 */
export function avatar(text: string): string {
  const ch = [...text.trim()][0] ?? "?";
  return `<span class="avatar" aria-hidden="true">${h(ch.toUpperCase())}</span>`;
}

/** タグを選ぶ欄（既存のタグをチップで選ぶ。allowNew なら新しいタグも入れられる） */
export function tagPicker(o: {
  name: string;
  tags: { name: string; count: number }[];
  selected: string[];
  disabled?: boolean;
  allowNew?: string;
  empty?: string;
}): string {
  const dis = o.disabled ? " disabled" : "";
  const sel = new Set(o.selected);
  // 選ばれているのに一覧に無いタグ（削除済みなど）も表示して、外せるようにする
  const all = [...o.tags, ...o.selected.filter((t) => !o.tags.some((x) => x.name === t)).map((name) => ({ name, count: 0 }))];
  const chipsHtml = all
    .map(
      (t) =>
        `<label class="chip-check"><input type="checkbox" name="${h(o.name)}" value="${h(t.name)}"${sel.has(t.name) ? " checked" : ""}${dis}><span>${h(t.name)}<small>${t.count}</small></span></label>`,
    )
    .join("");
  const none = all.length ? "" : `<span class="muted">${h(o.empty ?? "まだタグがありません")}</span>`;
  const add = o.allowNew && !o.disabled ? `<input class="new-tag" type="text" name="${h(o.allowNew)}" placeholder="新しいタグ（カンマ区切りで複数）" maxlength="200">` : "";
  return `<div class="tag-picker">${chipsHtml}${none}</div>${add}`;
}

/** 配信の種類を選ぶ欄（カードの中から 1 つ） */
export function topicPicker(o: {
  topics: { id: string; name: string; description: string | null }[];
  current: string | null | undefined;
  disabled?: boolean;
  noneLabel?: string;
}): string {
  const dis = o.disabled ? " disabled" : "";
  const card = (id: string, name: string, desc: string) =>
    `<label class="topic-card"><input type="radio" name="topic_id" value="${h(id)}"${(o.current ?? "") === id ? " checked" : ""}${dis}><span><b>${h(name)}</b>${desc ? `<small>${h(desc)}</small>` : ""}</span></label>`;
  return `<div class="topic-cards">${card("", o.noneLabel ?? "指定しない", "配信中の全員に届く")}${o.topics.map((t) => card(t.id, t.name, t.description ?? "")).join("")}</div>
${o.topics.length ? "" : `<p class="muted" style="margin:4px 0 0">「メルマガ本誌」「お知らせ」のように分けると、読者が受け取る種類を選べます（<a href="/admin/topics">配信の種類を作る</a>）。</p>`}`;
}

/** タブ（件数つき） */
export function tabs(items: { href: string; label: string; count?: number; current: boolean }[]): string {
  return `<nav class="tabs">${items
    .map((t) => `<a href="${t.href}"${t.current ? ' aria-current="page"' : ""}>${h(t.label)}${t.count !== undefined ? `<span class="count">${t.count}</span>` : ""}</a>`)
    .join("")}</nav>`;
}

export function loginPage(error?: string): string {
  return `${head("ログイン")}
<body><div class="login"><div class="card"><div class="login-brand">${logoMark(48, "tz-l")}<div><div class="wordmark">${h(BRAND.name)}</div><p class="tagline">${h(BRAND.tagline)}</p></div></div>
<p class="promise">${h(BRAND.promise)}</p>
${error ? `<div class="flash error" role="alert">${icon("circle-x", 16)}${h(error)}</div>` : ""}
<form method="post" action="/admin/login">
<label for="password">パスワード</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<label for="code">認証アプリの 6 桁のコード</label><input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required>
<div class="actions"><button type="submit" style="width:100%">ログイン</button></div></form></div></div></body></html>`;
}

const STATUS_LABEL: Record<string, [string, string]> = {
  pending: ["仮登録", "warn"],
  active: ["有効", "good"],
  paused: ["一時停止", "warn"],
  unsubscribed: ["配信停止", "bad"],
  stopped: ["停止", "bad"],
  bounced: ["不達", "bad"],
  complained: ["苦情", "bad"],
  blocked: ["ブロック", "bad"],
  queued: ["送信待ち", "info"],
  sending: ["送信中", "info"],
  sent: ["送信済み", "good"],
  delivered: ["配達済み", "good"],
  failed: ["失敗", "bad"],
  skipped: ["スキップ", ""],
  draft: ["下書き", ""],
  scheduled: ["予約中", "info"],
  testing: ["A/B テスト中", "info"],
  canceled: ["取り消し", ""],
  archived: ["アーカイブ", ""],
  completed: ["完了", "good"],
};

const TIER_LABEL: Record<string, [string, string]> = {
  evaluating: ["評価中", ""],
  hot: ["熱心", "good"],
  normal: ["通常", ""],
  low: ["低下", "warn"],
  dormant: ["休眠", "bad"],
};

export function statusPill(s: string): string {
  const [label, cls] = STATUS_LABEL[s] ?? [s, ""];
  return `<span class="pill ${cls}">${h(label)}</span>`;
}

export function tierPill(t: string): string {
  const [label, cls] = TIER_LABEL[t] ?? [t, ""];
  return `<span class="pill ${cls}">${h(label)}</span>`;
}

export const TIERS: [string, string][] = [
  ["hot", "熱心"],
  ["normal", "通常"],
  ["low", "低下"],
  ["dormant", "休眠"],
  ["evaluating", "評価中"],
];

const JST = 9 * 3_600_000;

/** 「2026/11/13 08:00」形式（日本時間） */
export function jst(d: Date | string | null | undefined): string {
  if (!d) return "";
  const t = new Date(new Date(d).getTime() + JST);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

/** datetime-local 入力（日本時間として扱う）→ Date */
export function fromJstInput(v: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return undefined;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) - JST);
}

/** Date → datetime-local 入力の値（日本時間） */
export function toJstInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  return jst(d).replace(/\//g, "-").replace(" ", "T");
}

export function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

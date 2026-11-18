/**
 * デザインシステム「tsuzuri」のトークン（https://claude.ai/artifact/8KFvHUy6jBMogP1Mvzh1dQ の tokens.json と同じ値）。
 * 管理画面と読者向けページの両方がこれを使う。値を変えるときは、デザインシステム側もそろえる。
 *
 * ブランド DNA：Precision（正確さ・信頼性）／Editorial（書き手の視点）／Intelligence（データで育てる）／
 * Minimalism（迷わない設計）／Calm Technology（続けられる心地よさ）。
 * 色はムードボードのパレットから採った深い青緑（#0e6b7b）を軸に、空色（#70c4cf）と淡い水色（#a4dee0）を補助に使う。
 * 文字と背景の組み合わせは、すべて WCAG AA（4.5:1 以上）を満たす。
 */
export const TOKENS_CSS = `
:root{color-scheme:light;
--canvas:#f6f9fa;--surface:#ffffff;--surface-sunken:#eef4f6;--line:#dde6e9;--line-strong:#9eb1b7;
--ink:#0c2530;--ink-muted:#4f646c;--accent:#0e6b7b;--accent-ink:#ffffff;--accent-soft:#e4f4f6;
--accent-2:#70c4cf;--accent-3:#a4dee0;--brand-deep:#092832;
--success:#1d7346;--success-soft:#e3f3ea;--info:#1f6f99;--info-soft:#e1f2fb;
--warning:#94560a;--warning-soft:#fbf0dc;--danger:#b2261c;--danger-soft:#fbe7e5;
--chart-1:#0e6b7b;--chart-2:#70c4cf;--chart-3:#a4dee0;--chart-4:#e9b15c;--chart-5:#c9d3d6;
--shadow-focus:0 0 0 3px rgba(14,107,123,.28);--shadow-card:0 1px 2px rgba(12,37,48,.04),0 4px 16px rgba(12,37,48,.04);
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--space-8:32px;
--radius-sm:6px;--radius-md:12px;--radius-lg:16px;--radius-pill:999px;
--text-h1:32px;--text-h2:24px;--text-h3:20px;--text-body:16px;--text-note:14px;--text-small:12px;
--font-sans:"IBM Plex Sans JP","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
--font-serif:"Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif;
--font-mono:"IBM Plex Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;
--canvas:#0b1b21;--surface:#0f2229;--surface-sunken:#0c1d23;--line:#1f3a44;--line-strong:#46616b;
--ink:#e6eff1;--ink-muted:#9ab2b9;--accent:#70c4cf;--accent-ink:#06222c;--accent-soft:#143642;
--accent-2:#39808e;--accent-3:#20556b;--brand-deep:#092832;
--success:#6fd39b;--success-soft:#12301f;--info:#7cc4ec;--info-soft:#10304a;
--warning:#f2b866;--warning-soft:#33240d;--danger:#ff8f86;--danger-soft:#3a1714;
--chart-1:#70c4cf;--chart-2:#39808e;--chart-3:#20556b;--chart-4:#d9a24f;--chart-5:#46616b;
--shadow-focus:0 0 0 3px rgba(112,196,207,.35);--shadow-card:none}}
`;

/**
 * 管理画面だけが読み込む Web フォント（読者向けページは外部へ通信しないよう、端末の書体を使う）。
 * ロゴ用の明朝（Noto Serif JP）は、ロゴに使う文字だけを text= で切り出して読み込む。
 */
export const ADMIN_FONTS_LINK =
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans+JP:wght@400;500;600&display=swap">' +
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@600&display=swap&text=${encodeURIComponent("綴tsuzuri-mail")}">`;

/** ブランドの言葉（ムードボードより） */
export const BRAND = {
  name: "tsuzuri-mail",
  tagline: "書き手のための、メルマガ・シナリオ配信ツール",
  promise: "書くことを、もっと、続けられるしくみ。",
} as const;

/**
 * ロゴマーク：深い青緑の角丸に、白い明朝の「綴」と筆の払いのような線。
 * 色はブランド固有の値なので、ここでだけ直接書く（テーマで変えない）。
 */
export function logoMark(size = 32, id = "tz"): string {
  return `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14808f"/><stop offset=".55" stop-color="#0e6b7b"/><stop offset="1" stop-color="#092832"/></linearGradient></defs>
<rect width="64" height="64" rx="15" fill="url(#${id}-g)"/>
<text x="32" y="41" text-anchor="middle" font-family="'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif" font-weight="600" font-size="34" fill="#ffffff">綴</text>
<path d="M13 49c10 2.4 24 2.2 38-3.2" fill="none" stroke="#a4dee0" stroke-width="2.2" stroke-linecap="round"/></svg>`;
}

/** ブラウザのタブに出すアイコン（データ URI。外部への読み込みなし） */
export const FAVICON_LINK = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(logoMark(64, "fav"))}">`;

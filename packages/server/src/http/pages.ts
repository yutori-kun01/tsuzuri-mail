import { DEFAULT_FIELDS, escapeHtml, NAME_FIELD_KEY, type FormField } from "@tsuzuri/core";
import { TOKENS_CSS } from "../ui/theme.js";

/**
 * 読者向けの小さなページ。デザインシステム「tsuzuri」のトークンを使い、外部の CSS・JS・フォントは読み込まない
 * （読者の IP アドレスを第三者に送らないため。書体は端末のものを使う）。
 */
const READER_STYLE = `${TOKENS_CSS}
:root{--font-sans:"Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif;--bg:var(--canvas);--card:var(--surface);--muted:var(--ink-muted)}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:400 15px/1.8 var(--font-sans);-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:0 auto;padding:48px max(16px,env(safe-area-inset-right,0px)) 48px max(16px,env(safe-area-inset-left,0px))}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-8) var(--space-6)}
h1{font-size:20px;line-height:1.5;margin:0 0 var(--space-3);text-wrap:balance}
h2{font-size:15px}
p{margin:0 0 var(--space-3)}
.muted{color:var(--ink-muted);font-size:13px;line-height:1.7}
label{display:block;font-size:13px;font-weight:500;color:var(--ink-muted);margin:var(--space-4) 0 var(--space-1)}
input[type=email],input[type=text],input[type=number],input[type=date],select,textarea{width:100%;height:44px;padding:0 var(--space-3);font:400 16px/1.5 var(--font-sans);border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink)}
textarea{height:auto;min-height:96px;padding:var(--space-2) var(--space-3)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:var(--shadow-focus)}
input[type=checkbox],input[type=radio]{width:18px;height:18px;accent-color:var(--accent);flex:none}
fieldset{border:0;margin:var(--space-4) 0 0;padding:0}
legend{padding:0;font-size:13px;font-weight:500;color:var(--ink-muted);margin-bottom:var(--space-1)}
.choice{display:flex;gap:var(--space-2);align-items:center;margin:var(--space-1) 0;color:var(--ink);font-size:15px;font-weight:400}
.req{color:var(--danger);font-size:12px;margin-left:var(--space-1)}
button{margin-top:var(--space-6);width:100%;height:46px;font:600 16px/1 var(--font-sans);border:1px solid var(--accent);border-radius:var(--radius-sm);background:var(--accent);color:var(--accent-ink);cursor:pointer}
button:hover{filter:brightness(1.08)}
button.secondary{margin-top:var(--space-2);height:40px;background:var(--surface);color:var(--accent);border-color:var(--line-strong);font-weight:500;font-size:14px}
.typo{margin:var(--space-3) 0;padding:var(--space-3) var(--space-4);border-radius:var(--radius-sm);background:var(--warning-soft);color:var(--warning);font-size:14px}.typo p{margin:var(--space-1) 0 0;color:var(--ink)}
button:focus-visible{outline:none;box-shadow:var(--shadow-focus)}
.hp{position:absolute;left:-9999px}
a{color:var(--accent)}
.footer{margin-top:var(--space-4);text-align:center;color:var(--ink-muted);font-size:12px}
`;

export function page(title: string, bodyHtml: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>${READER_STYLE}</style>${extraHead}</head>
<body><main><div class="card">${bodyHtml}</div></main></body></html>`;
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/**
 * 入力項目（メールアドレス以外）の HTML。embed は貼り付け先の CSS に任せるため tsuzuri- のクラス名だけを付ける。
 * values は送信に失敗したときに入力を残すためのもの。
 */
export function fieldInputs(
  fields: readonly FormField[],
  mode: "page" | "embed",
  values: Record<string, string | string[] | undefined> = {},
): string {
  const e = escapeHtml;
  const cls = (base: string) => (mode === "embed" ? ` class="tsuzuri-${base}"` : "");
  const valueOf = (f: FormField) => {
    const v = values[f.key];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? f.defaultValue);
  };
  const picked = (f: FormField) => {
    const v = values[f.key];
    return new Set(Array.isArray(v) ? v : v ? [v] : []);
  };
  const suffix = (f: FormField) => (f.required ? "（必須）" : "（任意）");
  const out: string[] = [];
  for (const f of fields) {
    if (!f.enabled) continue;
    const id = `tz-${f.key}`;
    const idAttr = mode === "page" ? ` id="${id}"` : "";
    const req = f.required ? " required" : "";
    const isName = f.key === NAME_FIELD_KEY;
    const max = isName ? 40 : 500;
    if (f.type === "hidden") {
      out.push(`<input type="hidden" name="${e(f.key)}" value="${e(f.defaultValue)}">`);
      continue;
    }
    if (f.type === "radio" || f.type === "checkbox") {
      const chosen = picked(f);
      const items = f.options
        .map(
          (o) =>
            `<label${mode === "embed" ? ' class="tsuzuri-choice"' : ' class="choice"'}><input type="${f.type}" name="${e(f.key)}" value="${e(o)}"${chosen.has(o) ? " checked" : ""}${f.type === "radio" ? req : ""}>${e(o)}</label>`,
        )
        .join("");
      out.push(`<fieldset${cls("fieldset")}><legend${cls("label")}>${e(f.label)}${suffix(f)}</legend>${items}</fieldset>`);
      continue;
    }
    let control: string;
    if (f.type === "select") {
      const v = valueOf(f);
      control = `<select${cls("input")}${idAttr} name="${e(f.key)}"${req}><option value="">選んでください</option>${f.options.map((o) => `<option${o === v ? " selected" : ""}>${e(o)}</option>`).join("")}</select>`;
    } else if (f.type === "textarea") {
      control = `<textarea${cls("input")}${idAttr} name="${e(f.key)}" maxlength="${max}"${req}>${e(valueOf(f))}</textarea>`;
    } else {
      const type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
      const auto = isName ? ' autocomplete="nickname"' : "";
      control = `<input${cls("input")}${idAttr} name="${e(f.key)}" type="${type}"${type === "text" ? ` maxlength="${max}"` : ""}${auto} value="${e(valueOf(f))}"${req}>`;
    }
    out.push(mode === "embed" ? `<label class="tsuzuri-label">${e(f.label)}${suffix(f)}${control}</label>` : `<label for="${id}">${e(f.label)}${suffix(f)}</label>${control}`);
  }
  return out.join("\n");
}

export function formPage(opts: {
  action: string;
  title: string;
  description?: string;
  buttonLabel?: string;
  privacyUrl?: string;
  error?: string;
  fields?: readonly FormField[];
  /** 送信に失敗したときに入力を残す */
  values?: Record<string, string | string[] | undefined>;
  /** 登録経路の識別名（?r=）。隠し欄で送信に引き継ぐ */
  route?: string;
  /** メールアドレスの打ち間違いの確認：入力されたアドレスと、直したアドレス */
  typo?: { typed: string; suggestion: string };
}): string {
  const e = escapeHtml;
  const privacy = opts.privacyUrl
    ? `<p class="muted">登録すると、<a href="${e(opts.privacyUrl)}">プライバシーポリシー</a>に同意のうえ、メールマガジンを受け取ることになります。配信はいつでも停止できます。</p>`
    : `<p class="muted">登録すると、メールマガジンを受け取ることになります。配信はいつでも停止できます。</p>`;
  const email = opts.typo ? opts.typo.suggestion : typeof opts.values?.email === "string" ? opts.values.email : "";
  const typoNote = opts.typo
    ? `<div class="typo" role="alert"><b>メールアドレスをご確認ください</b><p>「${e(opts.typo.typed)}」ではなく「<b>${e(opts.typo.suggestion)}</b>」ではありませんか？ 入力欄を直しておきました。</p></div>`
    : "";
  const buttons = opts.typo
    ? `<input type="hidden" name="email_checked" value="1">
<button type="submit">直したアドレスで${e(opts.buttonLabel ?? "登録する")}</button>
<button type="submit" class="secondary" name="email_keep" value="${e(opts.typo.typed)}">「${e(opts.typo.typed)}」のまま登録する</button>`
    : `<button type="submit">${e(opts.buttonLabel ?? "登録する")}</button>`;
  return page(
    opts.title,
    `<h1>${e(opts.title)}</h1>
${opts.description ? opts.description.split(/\n{2,}/).map((p) => `<p>${e(p).replace(/\n/g, "<br>")}</p>`).join("") : ""}
${opts.error ? `<p style="color:#c53030">${e(opts.error)}</p>` : ""}
${typoNote}
<form method="post" action="${e(opts.action)}">
<label for="email">メールアドレス</label><input id="email" name="email" type="email" required autocomplete="email" value="${e(email)}">
${fieldInputs(opts.fields ?? DEFAULT_FIELDS, "page", opts.values)}
${opts.route ? `<input type="hidden" name="r" value="${e(opts.route)}">` : ""}
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
${buttons}
</form>
${privacy}`,
  );
}

/**
 * 他サイトに貼る埋め込み用フォームの HTML。
 * 見た目は貼り付け先のサイトの CSS に任せ、クラス名だけ付ける（tsuzuri-form など）。
 */
export function embedSnippet(opts: { action: string; buttonLabel?: string; withName?: boolean; fields?: readonly FormField[]; route?: string }): string {
  const fields = (opts.fields ?? DEFAULT_FIELDS).filter((f) => !(opts.withName === false && f.key === NAME_FIELD_KEY));
  const extra =
    fieldInputs(fields, "embed")
      .split("\n")
      .filter(Boolean)
      .map((l) => `\n  ${l}`)
      .join("") + (opts.route ? `\n  <input type="hidden" name="r" value="${escapeHtml(opts.route)}">` : "");
  return `<form class="tsuzuri-form" method="post" action="${escapeHtml(opts.action)}">
  <label class="tsuzuri-label">メールアドレス<input class="tsuzuri-input" name="email" type="email" required maxlength="254" autocomplete="email"></label>${extra}
  <input name="website" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off" aria-hidden="true">
  <button class="tsuzuri-button" type="submit">${escapeHtml(opts.buttonLabel ?? "登録する")}</button>
</form>`;
}

/** Web 版：末尾まで読み、15 秒以上滞在したら読了として送る */
export function readBeaconScript(readUrl: string): string {
  return `<script>(function(){var u=${JSON.stringify(readUrl)},t0=Date.now(),sent=false,seen=false;
var end=document.getElementById("tz-end");if(!end||!("IntersectionObserver" in window))return;
function go(){if(sent||!seen||Date.now()-t0<15000)return;sent=true;navigator.sendBeacon?navigator.sendBeacon(u):fetch(u,{method:"POST",keepalive:true});}
new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){seen=true;go();}});}).observe(end);
setInterval(go,3000);})();</script>`;
}

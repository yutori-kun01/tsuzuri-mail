import { commerceDisclosureRows, createToken, escapeHtml, normalizeFields, PaymentSignatureError, renderEmail, suggestEmailFix, validateSubmission, verifyToken } from "@tsuzuri/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { senderInfoUrl, url, type AppContext } from "../context.js";
import { confirm, FORM_OPEN_SQL, subscribe, unsubscribe } from "../services/subscription.js";
import { recordClick, recordDownload, recordOpen, recordRead } from "../services/tracking.js";
import { listCustomVariables } from "../services/variables.js";
import { handlePaymentEvent } from "../services/commerce.js";
import { getPreferences, PAUSE_OPTIONS, savePreferences } from "../services/preferences.js";
import { createAdmin } from "../admin/index.js";
import { downloadResponse } from "../providers/files.js";
import { DEFAULT_RULES, rateLimit, type RateLimitOptions } from "./ratelimit.js";
import { embedSnippet, formPage, messagePage, page, readBeaconScript } from "./pages.js";

/** 1x1 の透明 GIF */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** 読者向けページの既定の CSP（外部のスクリプト・フレーム埋め込みを禁止） */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'";

export interface AppOptions {
  /** 確認メールなど、すぐ送るべき送信記録をキューに積む */
  enqueue: (ids: string[]) => Promise<void>;
  /** フォームに privacy_url が無いときに使うプライバシーポリシーの URL */
  privacyUrl?: string;
  /** IP ごとのレート制限を入れる。true はプロセス内メモリ（VPS）。Workers はバインディングを渡す。Lambda では API Gateway 側で制限する */
  rateLimit?: boolean | RateLimitOptions;
  /**
   * どの画面を載せるか（既定はどちらも）。Cloudflare では読者向けと管理画面を別の Worker にして、
   * 管理画面の Worker だけに Cloudflare Access をかけられる。
   */
  surfaces?: { public?: boolean; admin?: boolean };
  /** /admin の前に挟む確認（Cloudflare Access の JWT の確認など） */
  adminGuard?: MiddlewareHandler;
  /** 別のサイトのページから fetch で登録 API を呼ぶときに許すオリジン（CORS） */
  corsOrigins?: string[];
}


interface FormRow {
  id: string;
  slug: string;
  name: string;
  page_title: string | null;
  page_description: string | null;
  button_label: string;
  sent_url: string | null;
  sent_message: string | null;
  confirmed_message: string | null;
  privacy_url: string | null;
  allowed_origins: string[];
  fields: unknown;
  thanks_url: string | null;
  double_optin: boolean;
}

const FORM_COLUMNS =
  "id, slug, name, page_title, page_description, button_label, sent_url, sent_message, confirmed_message, privacy_url, allowed_origins, fields, thanks_url, double_optin";

/** フォームの送信内容（チェックボックスは同じ名前で複数の値が来る） */
async function readFormValues(c: Context): Promise<Record<string, string | string[]>> {
  const type = c.req.header("content-type") ?? "";
  const pick = (v: unknown): string | string[] =>
    typeof v === "string" ? v : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : "";
  if (type.includes("application/json")) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, pick(v)]));
  }
  const body = await c.req.parseBody({ all: true });
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, pick(v)]));
}

function reqInfo(c: Context) {
  return { method: c.req.method, userAgent: c.req.header("user-agent") };
}

async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  }
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

/** 登録経路の識別名（?r=）。形が正しいものだけを使う（存在しない識別名は、記録するときに経路なしになる） */
function routeCode(v: string | undefined): string | undefined {
  const s = (v ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(s) ? s : undefined;
}

/** 制御文字を除き、前後の空白を落として長さを制限する */
function clean(s: string | undefined, max: number): string {
  return (s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** リクエスト元のオリジン（Origin ヘッダー、無ければ Referer から） */
function requestOrigin(c: Context): string | undefined {
  const origin = c.req.header("origin");
  if (origin && origin !== "null") return origin;
  const ref = c.req.header("referer");
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}

export function createApp(getCtx: () => Promise<AppContext>, opts: AppOptions): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Strict-Transport-Security", "max-age=31536000");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", PAGE_CSP);
  });
  // 読者向けの送信データは小さいはずなので、大きなリクエストは受けない（管理画面はメール本文を送るので大きめ）
  const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.text("too large", 413) });
  const adminBody = bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.text("too large", 413) });
  // 外部サービスからの通知（決済の Webhook）は読者向けより少し大きい
  const hookBody = bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.text("too large", 413) });
  // 引き継ぎ・バックアップのファイルの読み込みは大きい（Workers の上限は 100MB）
  const transferBody = bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => c.text("too large", 413) });
  app.use("*", (c, next) => {
    const p = c.req.path;
    if (p === "/admin/transfer/import") return transferBody(c, next);
    if (p.startsWith("/admin")) return adminBody(c, next);
    if (p.startsWith("/hooks/")) return hookBody(c, next);
    return smallBody(c, next);
  });
  // レート制限は管理画面より先に入れる（後に入れると /admin には効かない）
  if (opts.rateLimit) app.use("*", rateLimit(DEFAULT_RULES, opts.rateLimit === true ? Date.now : opts.rateLimit));
  if (opts.surfaces?.admin !== false) {
    if (opts.adminGuard) {
      app.use("/admin", opts.adminGuard);
      app.use("/admin/*", opts.adminGuard);
    }
    app.route("/admin", createAdmin(getCtx, { enqueue: opts.enqueue }));
  }

  app.get("/health", (c) => c.text("ok"));
  // 管理画面だけの Worker では、読者向けのページを出さない
  if (opts.surfaces?.public === false) app.use("*", async (c) => c.text("not found", 404));

  if (opts.corsOrigins?.length) {
    const allowed = new Set(opts.corsOrigins);
    app.use(
      "/f/*",
      cors({ origin: (o) => (allowed.has(o) ? o : null), allowMethods: ["POST"], allowHeaders: ["Content-Type", "Accept"], maxAge: 600 }),
    );
  }

  // 自分で配る保存先（VPS のディスク、R2）に置いた特典ファイル（署名付き・期限付きのリンクでだけ配る）
  app.get("/files/:token", async (c) => {
    const ctx = await getCtx();
    const file = ctx.storage?.open ? await ctx.storage.open(c.req.param("token")) : undefined;
    if (!file) return c.html(messagePage("ダウンロードできません", "リンクの期限が切れたか、ファイルが見つかりません。メールのリンクからもう一度お試しください。"), 404);
    return downloadResponse(file);
  });

  /** 受付中のフォーム。openOnly なら受付期間の外も「無い」扱いにする */
  const loadForm = async (ctx: AppContext, slug: string, openOnly = true): Promise<FormRow | undefined> =>
    (
      await ctx.db.query<FormRow>(
        `SELECT ${FORM_COLUMNS} FROM forms WHERE slug = $1 AND active${openOnly ? ` AND ${FORM_OPEN_SQL("$2")}` : ""}`,
        openOnly ? [slug, ctx.now()] : [slug],
      )
    )[0];

  const renderForm = (
    ctx: AppContext,
    form: FormRow,
    error?: string,
    values?: Record<string, string | string[]>,
    extra: { route?: string; typo?: { typed: string; suggestion: string } } = {},
  ) =>
    formPage({
      ...(extra.route ? { route: extra.route } : {}),
      ...(extra.typo ? { typo: extra.typo } : {}),
      action: url(ctx, `/f/${form.slug}`),
      title: form.page_title ?? form.name,
      ...(form.page_description ? { description: form.page_description } : {}),
      buttonLabel: form.button_label,
      ...((form.privacy_url ?? opts.privacyUrl) ? { privacyUrl: (form.privacy_url ?? opts.privacyUrl)! } : {}),
      ...(error ? { error } : {}),
      fields: normalizeFields(form.fields),
      ...(values ? { values } : {}),
    });

  // ---- 登録フォーム（キャンペーン・メルマガごと） ----
  app.get("/f/:slug", async (c) => {
    const ctx = await getCtx();
    const form = await loadForm(ctx, c.req.param("slug"));
    if (!form) return c.html(messagePage("見つかりません", "このフォームは存在しないか、受付を終了しました。"), 404);
    const route = routeCode(c.req.query("r"));
    return c.html(renderForm(ctx, form, undefined, undefined, route ? { route } : {}));
  });

  // 他のページに貼るためのフォームタグ
  app.get("/f/:slug/embed", async (c) => {
    const ctx = await getCtx();
    const form = await loadForm(ctx, c.req.param("slug"));
    if (!form) return c.text("not found", 404);
    return c.text(embedSnippet({ action: url(ctx, `/f/${form.slug}`), buttonLabel: form.button_label, fields: normalizeFields(form.fields) }));
  });

  app.post("/f/:slug", async (c) => {
    const ctx = await getCtx();
    const form = await loadForm(ctx, c.req.param("slug"));
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    if (!form) return wantsJson ? c.json({ ok: false }, 404) : c.html(messagePage("見つかりません", "このフォームは受付を終了しました。"), 404);

    // 埋め込みを許可したサイト以外からの送信を拒否（自前のフォームページは常に許可）
    if (form.allowed_origins.length > 0) {
      const origin = requestOrigin(c);
      const own = [ctx.publicBaseUrl, ctx.linkBaseUrl].filter((u): u is string => Boolean(u)).map((u) => new URL(u).origin);
      if (!origin || (!own.includes(origin) && !form.allowed_origins.includes(origin))) {
        return wantsJson ? c.json({ ok: false, error: "origin" }, 403) : c.html(messagePage("送信できません", "このページからは登録できません。"), 403);
      }
    }

    const body = await readFormValues(c);
    const one = (k: string) => {
      const v = body[k];
      return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
    };
    const done = () => (wantsJson ? c.json({ ok: true }) : c.redirect(form.sent_url ?? url(ctx, `/f/${form.slug}/sent`), 303));
    // ボット対策：見えない欄に入力があれば、成功したふりをして何もしない
    if (one("website")) return done();

    const route = routeCode(one("r"));
    const keep = { ...(route ? { route } : {}) };
    const checked = validateSubmission(normalizeFields(form.fields), body);
    if (!checked.ok) {
      if (wantsJson) return c.json({ ok: false, error: "invalid-field", message: checked.error }, 400);
      return c.html(renderForm(ctx, form, checked.error, body, keep), 400);
    }
    // 主要なメールサービスの打ち間違い（gmial.com など）は、登録する前に一度確かめる
    const email = clean(one("email_keep") || one("email"), 254);
    const suggestion = one("email_checked") === "1" ? undefined : suggestEmailFix(email);
    if (suggestion) {
      if (wantsJson) return c.json({ ok: false, error: "email-typo", suggestion }, 400);
      return c.html(renderForm(ctx, form, undefined, body, { ...keep, typo: { typed: email, suggestion } }), 200);
    }
    const { name, attributes } = checked.value;
    const r = await subscribe(ctx, {
      formSlug: form.slug,
      email,
      ...(name ? { name } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(route ? { route } : {}),
    });
    if (r.status === "invalid-email") {
      if (wantsJson) return c.json({ ok: false, error: "invalid-email" }, 400);
      return c.html(renderForm(ctx, form, "メールアドレスを確認してください。", body, keep), 400);
    }
    if (r.status === "form-not-found") return wantsJson ? c.json({ ok: false }, 404) : c.html(messagePage("見つかりません", "このフォームは受付を終了しました。"), 404);
    if (r.status === "confirmation-sent") await opts.enqueue([r.messageId]);
    // シングルオプトイン：確認メールなしで登録完了。完了ページへ（既に登録済みの人も同じ画面にして、アドレスの有無を推測させない）
    if (form.double_optin === false && (r.status === "subscribed" || r.status === "already-active")) {
      // 特典などシナリオの 1 通目をすぐ送れるよう、送信処理を起こす（失敗しても次の定期処理で送られる）
      if (r.status === "subscribed") await opts.enqueue([]).catch(() => undefined);
      return wantsJson ? c.json({ ok: true, subscribed: true }) : c.redirect(form.thanks_url ?? url(ctx, `/f/${form.slug}/done`), 303);
    }
    // 既に登録済みか・送信を制限中かは画面で区別しない（アドレスの存在を推測されないため）
    return done();
  });

  // シングルオプトインの登録完了ページ（フォームの「登録完了後に移動するページ」が空のとき）
  app.get("/f/:slug/done", async (c) => {
    const ctx = await getCtx();
    const form = await loadForm(ctx, c.req.param("slug"), false);
    return c.html(messagePage("登録が完了しました", form?.confirmed_message ?? "まもなく最初のメールが届きます。届かない場合は迷惑メールフォルダもご確認ください。"));
  });

  app.get("/f/:slug/sent", async (c) => {
    const ctx = await getCtx();
    const form = await loadForm(ctx, c.req.param("slug"), false);
    return c.html(
      messagePage(
        "確認メールを送りました",
        form?.sent_message ?? "メールに記載のリンクを押すと登録が完了します。届かない場合は迷惑メールフォルダもご確認ください。",
      ),
    );
  });

  // 以前のリンク互換
  app.get("/sent", (c) =>
    c.html(messagePage("確認メールを送りました", "メールに記載のリンクを押すと登録が完了します。届かない場合は迷惑メールフォルダもご確認ください。")),
  );

  app.get("/confirm/:token", async (c) => {
    const ctx = await getCtx();
    const r = await confirm(ctx, c.req.param("token"));
    if (r.status !== "confirmed") return c.html(messagePage("リンクが無効です", "お手数ですが、もう一度フォームからご登録ください。"), 400);
    // 特典などシナリオの 1 通目をすぐ送れるよう、送信処理を起こす（失敗しても次の定期処理で送られる）
    await opts.enqueue([]).catch(() => undefined);
    if (r.thanksUrl) return c.redirect(r.thanksUrl, 303);
    return c.html(messagePage("登録が完了しました", r.confirmedMessage ?? "まもなく最初のメールが届きます。"));
  });

  // ---- 送信者情報（特定電子メール法の表示。メールのフッターからリンクする） ----
  app.get("/legal", async (c) => {
    const ctx = await getCtx();
    const s = ctx.settings;
    const rows = [
      ["送信者", s.senderName],
      ["住所", s.senderAddress ?? ""],
      ["お問い合わせ", s.contact],
    ].filter(([, v]) => v);
    return c.html(
      page(
        "送信者情報",
        `<h1>送信者情報</h1><p class="muted">特定電子メール法に基づく表示</p>
<dl>${rows.map(([k, v]) => `<dt class="muted">${escapeHtml(k!)}</dt><dd style="margin:0 0 12px">${escapeHtml(v!)}</dd>`).join("")}</dl>
<p class="muted">配信の停止は、各メールの末尾にある「配信停止」から行えます。</p>`,
      ),
    );
  });

  // ---- 特定商取引法に基づく表記（設定の「販売者の表記」から自動で作る） ----
  app.get("/legal/commerce", async (c) => {
    const ctx = await getCtx();
    const d = ctx.settings.commerce;
    if (!d?.sellerName?.trim()) return c.html(messagePage("準備中です", "このページはまだ公開されていません。"), 404);
    const rows = commerceDisclosureRows(d);
    return c.html(
      page(
        "特定商取引法に基づく表記",
        `<h1>特定商取引法に基づく表記</h1>
<dl>${rows.map(([k, v]) => `<dt class="muted">${escapeHtml(k)}</dt><dd style="margin:0 0 12px;white-space:pre-wrap">${escapeHtml(v || "—")}</dd>`).join("")}</dl>`,
      ),
    );
  });

  // ---- 決済サービスからの通知（Webhook）。署名を確かめ、同じ通知は 1 回だけ処理する ----
  app.post("/hooks/:provider", async (c) => {
    const ctx = await getCtx();
    const provider = ctx.payments?.find((p) => p.name === c.req.param("provider"));
    if (!provider) return c.text("not found", 404);
    const raw = await c.req.text();
    let ev;
    try {
      ev = await provider.parseWebhook(raw, (n) => c.req.header(n), ctx.now());
    } catch (e) {
      if (e instanceof PaymentSignatureError) return c.text("bad signature", 400);
      throw e;
    }
    // 失敗したら 500 を返し、決済サービスに送り直してもらう（記録はトランザクションごと戻る）
    const outcome = await handlePaymentEvent(ctx, provider.name, ev);
    if (outcome !== "processed" && outcome !== "duplicate" && outcome !== "ignored") console.log("payment event", provider.name, ev.eventType, outcome);
    return c.json({ received: true });
  });

  // ---- 配信停止 ----
  app.get("/u/:token", async (c) => {
    const ctx = await getCtx();
    if (!verifyToken(c.req.param("token"), "unsubscribe", ctx.secret)) return c.html(messagePage("リンクが無効です", "メール内のリンクからもう一度お試しください。"), 400);
    return c.html(
      page("配信停止", `<h1>配信を停止しますか？</h1><p>停止すると、今後このメールマガジンは届かなくなります。</p>
<form method="post"><button type="submit">配信を停止する</button></form>`),
    );
  });

  // メールソフトのワンクリック配信停止（RFC 8058）もこの POST に来る
  app.post("/u/:token", async (c) => {
    const ctx = await getCtx();
    const contactId = verifyToken(c.req.param("token"), "unsubscribe", ctx.secret);
    if (!contactId) return c.html(messagePage("リンクが無効です", "メール内のリンクからもう一度お試しください。"), 400);
    await unsubscribe(ctx, contactId);
    return c.html(messagePage("配信を停止しました", "これまでお読みいただき、ありがとうございました。"));
  });

  // ---- 配信設定（受け取る種類・一時停止・配信停止） ----
  app.get("/p/:token", async (c) => {
    const ctx = await getCtx();
    const contactId = verifyToken(c.req.param("token"), "preferences", ctx.secret);
    const prefs = contactId ? await getPreferences(ctx, contactId) : undefined;
    if (!contactId || !prefs) return c.html(messagePage("リンクが無効です", "メール内のリンクからもう一度お試しください。"), 400);
    const unsub = url(ctx, `/u/${createToken("unsubscribe", contactId, ctx.secret)}`);
    if (prefs.status === "unsubscribed") {
      return c.html(messagePage("配信は停止されています", "もう一度受け取りたい場合は、登録フォームからご登録ください。"));
    }
    const saved = c.req.query("saved") === "1";
    const topics = prefs.topics.length
      ? `<h2 style="font-size:16px;margin:24px 0 8px">受け取るメール</h2>
${prefs.topics
  .map(
    (t) => `<label style="display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-size:15px;color:var(--ink)">
<input type="checkbox" name="topics" value="${escapeHtml(t.id)}"${t.subscribed ? " checked" : ""} style="margin-top:5px">
<span><b>${escapeHtml(t.name)}</b>${t.description ? `<br><span class="muted">${escapeHtml(t.description)}</span>` : ""}</span></label>`,
  )
  .join("")}`
      : "";
    const pausedNote = prefs.pausedUntil
      ? `<p class="muted">現在、${escapeHtml(prefs.pausedUntil.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }))} まで配信をお休みしています。</p>`
      : "";
    const until = prefs.pausedUntil?.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
    const pauseOptions = [
      ...(prefs.pausedUntil ? [`<option value="keep" selected>このまま（${escapeHtml(until ?? "")} までお休み）</option>`] : []),
      `<option value="0">${prefs.pausedUntil ? "お休みを終えて再開する" : "お休みしない"}</option>`,
      ...PAUSE_OPTIONS.map((d) => `<option value="${d}">${d} 日間お休みする</option>`),
    ].join("");
    return c.html(
      page(
        "配信設定",
        `<h1>配信設定</h1>
${saved ? '<p style="color:var(--success);font-weight:500">保存しました。</p>' : ""}
<form method="post">
${topics}
<h2 style="font-size:16px;margin:24px 0 8px">しばらくお休みする</h2>
${pausedNote}
<select name="pause" style="width:100%;padding:10px 12px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)">${pauseOptions}</select>
<p class="muted">お休みの間は、メールマガジンも自動のメールも届きません。期間が終わると自動で再開します。</p>
<button type="submit">保存する</button>
</form>
<p class="muted" style="margin-top:24px">すべてのメールを止める場合は<a href="${unsub}">配信停止</a>へ。</p>`,
      ),
    );
  });

  app.post("/p/:token", async (c) => {
    const ctx = await getCtx();
    const contactId = verifyToken(c.req.param("token"), "preferences", ctx.secret);
    if (!contactId) return c.html(messagePage("リンクが無効です", "メール内のリンクからもう一度お試しください。"), 400);
    const body = await c.req.parseBody({ all: true });
    const raw = body.topics;
    const topics = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((x): x is string => typeof x === "string");
    const pause = body.pause === "keep" ? "keep" : Number(typeof body.pause === "string" ? body.pause : 0) || 0;
    const ok = await savePreferences(ctx, contactId, { subscribedTopicIds: topics, pauseDays: pause });
    if (!ok) return c.html(messagePage("保存できませんでした", "配信が停止されているか、リンクが無効です。"), 400);
    return c.redirect(`${url(ctx, `/p/${c.req.param("token")}`)}?saved=1`, 303);
  });

  // ---- 計測 ----
  const click = async (c: Context) => {
    const ctx = await getCtx();
    const to = await recordClick(ctx, c.req.param("token") ?? "", reqInfo(c));
    if (!to) return c.html(messagePage("リンクが無効です", "このリンクは使えません。"), 404);
    return c.redirect(to, 302);
  };
  app.get("/c/:token", click);
  app.on("HEAD", "/c/:token", click);

  app.get("/o/:file", async (c) => {
    const ctx = await getCtx();
    await recordOpen(ctx, c.req.param("file").replace(/\.gif$/, ""), reqInfo(c)).catch(() => undefined);
    return c.body(PIXEL, 200, { "Content-Type": "image/gif", "Cache-Control": "no-store, private" });
  });

  app.get("/d/:token", async (c) => {
    const ctx = await getCtx();
    const to = await recordDownload(ctx, c.req.param("token"), reqInfo(c));
    if (!to) return c.html(messagePage("ダウンロードできません", "リンクが無効か、特典が見つかりません。"), 404);
    return c.redirect(to, 302);
  });

  app.post("/r/:token", async (c) => {
    const ctx = await getCtx();
    await recordRead(ctx, c.req.param("token"));
    return c.body(null, 204);
  });

  // ---- Web 版 ----
  app.get("/w/:id", async (c) => {
    const ctx = await getCtx();
    const [b] = await ctx.db.query<{ subject: string | null; body_markdown: string; body_format: "markdown" | "html" }>(
      "SELECT subject, body_markdown, body_format FROM broadcasts WHERE id::text = $1 AND status = 'sent'",
      [c.req.param("id")],
    );
    if (!b) return c.html(messagePage("見つかりません", "この号は公開されていません。"), 404);
    const custom = await listCustomVariables(ctx.db);
    const s = ctx.settings;
    // Web 版には個人の情報や個人用リンクを入れない
    const rendered = renderEmail({
      subject: b.subject ?? "",
      body: b.body_markdown,
      format: b.body_format,
      context: {
        builtins: { name: s.defaultName ?? "", sender: s.senderName, contact: s.contact, cancel: "", settings: "", email: "" },
        custom,
        attributes: {},
      },
      footer: { senderName: s.senderName, contact: s.contact, senderInfoUrl: senderInfoUrl(ctx) },
      unsubscribeUrl: "",
    });
    const body = rendered.html.replace(/^[\s\S]*<body[^>]*>/, "").replace(/<\/body>[\s\S]*$/, "");
    const r = c.req.query("r");
    const beacon = r ? readBeaconScript(url(ctx, `/r/${r}`)) : "";
    // Web 版だけは読了計測のインラインスクリプトと外部画像を許可する
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    return c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${rendered.subject.replace(/</g, "&lt;")}</title></head><body style="margin:0;background:#ffffff">${body}<div id="tz-end"></div>${beacon}</body></html>`,
    );
  });

  app.onError((err, c) => {
    console.error("request failed", c.req.method, c.req.path.split("/").slice(0, 2).join("/"), err.message);
    return c.html(messagePage("エラーが発生しました", "時間をおいてもう一度お試しください。"), 500);
  });

  return app;
}

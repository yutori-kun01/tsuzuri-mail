import {
  newChallenge,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  COSE_ALGS,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@tsuzuri/core";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context.js";
import { audit, isLocked, startSession } from "./auth.js";
import { back, flashFrom, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, jst, pageHeader } from "./ui.js";
import { WEBAUTHN_CLIENT } from "./webauthn-client.js";

/**
 * 管理画面のパスキー。
 * - 登録はログイン中（パスワード＋認証アプリで入ったあと）にだけできる。
 * - ログインは、この端末のパスキーでも、PC の画面に出る QR コードをスマホで読み取る方式（ハイブリッド）でもできる。
 *   QR の表示と中継はブラウザと OS が行う。サーバー側は「どの端末か」を問わず同じ検証をする。
 * - 本人確認（生体認証・端末の PIN）を必須にしているので、パスキー 1 つでパスワード＋認証アプリの代わりになる。
 */

const CHALLENGE_MINUTES = 5;
/** ログイン前に発行できるチャレンジの上限（総当たりで表が膨らまないように） */
const MAX_OPEN_LOGIN_CHALLENGES = 30;
const MAX_JSON_BYTES = 16 * 1024;
/** 管理者は 1 人なので、ユーザー ID は固定 */
const USER_ID = Buffer.from("tsuzuri-admin").toString("base64url");

interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: string;
  alg: number;
  sign_count: string | number;
  transports: string[];
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

/** RP ID（公開 URL のホスト名）と、受け付けるオリジン */
export function relyingParty(ctx: AppContext, c: Context): { rpId: string; origins: string[] } {
  const base = new URL(ctx.adminBaseUrl || ctx.publicBaseUrl);
  const own = new URL(c.req.url).origin;
  return { rpId: base.hostname, origins: [...new Set([base.origin, own])] };
}

async function issueChallenge(ctx: AppContext, purpose: "register" | "login"): Promise<string | undefined> {
  const now = ctx.now();
  await ctx.db.query("DELETE FROM admin_webauthn_challenges WHERE expires_at <= $1", [now]);
  if (purpose === "login") {
    const [r] = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_webauthn_challenges WHERE purpose = 'login'");
    if ((r?.n ?? 0) >= MAX_OPEN_LOGIN_CHALLENGES) return undefined;
  }
  const challenge = newChallenge();
  await ctx.db.query("INSERT INTO admin_webauthn_challenges (challenge, purpose, expires_at) VALUES ($1, $2, $3)", [
    challenge,
    purpose,
    new Date(now.getTime() + CHALLENGE_MINUTES * 60_000),
  ]);
  return challenge;
}

/** clientDataJSON の中のチャレンジを、発行済みで期限内のものなら使い切る（1 回だけ使える） */
async function consumeChallenge(ctx: AppContext, clientDataJSON: unknown, purpose: "register" | "login"): Promise<string | undefined> {
  if (typeof clientDataJSON !== "string" || clientDataJSON.length > 4096) return undefined;
  let challenge: unknown;
  try {
    challenge = (JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown }).challenge;
  } catch {
    return undefined;
  }
  if (typeof challenge !== "string" || challenge.length > 200) return undefined;
  const rows = await ctx.db.query<{ challenge: string }>(
    "DELETE FROM admin_webauthn_challenges WHERE challenge = $1 AND purpose = $2 AND expires_at > $3 RETURNING challenge",
    [challenge, purpose, ctx.now()],
  );
  return rows[0]?.challenge;
}

async function readJson<T>(c: Context): Promise<T | undefined> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_JSON_BYTES) return undefined;
  const text = await c.req.text();
  if (text.length > MAX_JSON_BYTES) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function sameSite(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  return !site || site === "same-origin";
}

/** ログイン前に使うもの（requireAdmin より前に登録する） */
export function registerPasskeyLogin(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.post("/passkey/login/options", async (c) => {
    const ctx = await getCtx();
    if (!sameSite(c)) return c.json({ error: "forbidden" }, 403);
    if (!ctx.admin) return c.json({ error: "管理画面のログイン情報が設定されていません" }, 503);
    if (await isLocked(ctx)) return c.json({ error: "ログインの失敗が続いたため、15 分間ログインできません。" }, 429);
    const challenge = await issueChallenge(ctx, "login");
    if (!challenge) return c.json({ error: "しばらく待ってからもう一度お試しください。" }, 429);
    const { rpId } = relyingParty(ctx, c);
    // allowCredentials を空にして、端末に保存されたパスキー（スマホの QR 経由を含む）から選んでもらう
    return c.json({ challenge, rpId, timeout: CHALLENGE_MINUTES * 60_000, userVerification: "required" });
  });

  app.post("/passkey/login", async (c) => {
    const ctx = await getCtx();
    if (!sameSite(c)) return c.json({ error: "forbidden" }, 403);
    if (!ctx.admin) return c.json({ error: "管理画面のログイン情報が設定されていません" }, 503);
    if (await isLocked(ctx)) return c.json({ error: "ログインの失敗が続いたため、15 分間ログインできません。" }, 429);
    const fail = async (msg = "パスキーを確認できませんでした。") => {
      await ctx.db.query("INSERT INTO admin_login_failures (occurred_at) VALUES ($1)", [ctx.now()]);
      await audit(ctx.db, "admin.passkey_login_failed");
      return c.json({ error: msg }, 401);
    };
    const body = await readJson<AuthenticationResponseJSON>(c);
    if (!body?.response || typeof body.rawId !== "string") return fail();
    const challenge = await consumeChallenge(ctx, body.response.clientDataJSON, "login");
    if (!challenge) return fail("時間が経ちすぎたか、すでに使ったリクエストです。もう一度お試しください。");
    const [pk] = await ctx.db.query<PasskeyRow>("SELECT * FROM admin_passkeys WHERE credential_id = $1", [body.rawId]);
    if (!pk) return fail("このパスキーは登録されていません。パスワードでログインしてから「パスキー」で登録してください。");
    const { rpId, origins } = relyingParty(ctx, c);
    try {
      const r = verifyAuthentication({
        response: body,
        credential: { publicKey: pk.public_key, alg: pk.alg, signCount: Number(pk.sign_count) },
        expectedChallenge: challenge,
        expectedOrigins: origins,
        rpId,
      });
      await ctx.db.query("UPDATE admin_passkeys SET sign_count = $2, last_used_at = $3 WHERE id = $1", [pk.id, r.newSignCount, ctx.now()]);
    } catch (e) {
      if (e instanceof WebAuthnError) return fail();
      throw e;
    }
    await ctx.db.query("DELETE FROM admin_login_failures");
    await audit(ctx.db, "admin.login", undefined, { method: "passkey", passkey: pk.id });
    startSession(c, ctx);
    return c.json({ ok: true, redirect: "/admin" });
  });
}

const TRANSPORT_LABEL: Record<string, string> = { hybrid: "スマホ（QR）", internal: "この端末", usb: "USB キー", nfc: "NFC", ble: "Bluetooth" };

export function registerPasskeys(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/passkeys", async (c) => {
    const ctx = await getCtx();
    const rows = await ctx.db.query<PasskeyRow>("SELECT * FROM admin_passkeys ORDER BY created_at");
    const { rpId } = relyingParty(ctx, c);
    const list = rows.length
      ? `<div class="wrap"><table><tr><th>名前</th><th>種類</th><th>登録</th><th>最後に使った日時</th><th></th></tr>${rows
          .map(
            (r) => `<tr><td><b>${h(r.name)}</b></td><td>${(r.transports.length ? r.transports : ["internal"]).map((t) => `<span class="pill">${h(TRANSPORT_LABEL[t] ?? t)}</span>`).join("")}</td>
<td>${h(jst(r.created_at))}</td><td>${r.last_used_at ? h(jst(r.last_used_at)) : '<span class="muted">まだ使っていません</span>'}</td>
<td><div class="pk-acts"><details class="pk-rename"><summary class="btn sub">${icon("pencil", 14)}名前</summary><form method="post" action="/admin/passkeys/${h(r.id)}/rename" class="inline-form"><input type="text" name="name" value="${h(r.name)}" required maxlength="60" aria-label="名前"><button type="submit">保存</button></form></details>
<form method="post" action="/admin/passkeys/${h(r.id)}/delete" class="inline" onsubmit="return confirm('パスキー「${h(r.name)}」を削除しますか？（端末側のパスキーは残りますが、ログインには使えなくなります）')"><button type="submit" class="sub icon-only" title="削除" aria-label="削除">${icon("trash", 14)}</button></form></div></td></tr>`,
          )
          .join("")}</table></div>`
      : emptyState({ icon: "key-round", title: "まだパスキーがありません", text: "登録すると、次からはパスワードと認証アプリのコードの代わりに、指紋・顔認証・端末の PIN でログインできます。" });
    const body = `${pageHeader({ title: "パスキー", desc: "パスワードと認証アプリの代わりに、指紋・顔認証・端末の PIN で管理画面にログインできます。PC では、画面に出る QR コードをスマホで読み取って、スマホのパスキーでログインすることもできます。" })}
<style>.pk-acts{display:flex;gap:var(--space-2);align-items:center;justify-content:flex-end}.pk-rename{position:relative}.pk-rename>summary{list-style:none;height:28px;padding:0 var(--space-3);font-size:13px}.pk-rename>summary::-webkit-details-marker{display:none}
.pk-rename form{position:absolute;right:0;top:calc(100% + 4px);z-index:5;display:flex;gap:var(--space-2);padding:var(--space-2);width:300px;max-width:80vw;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow-card)}
.pk-choice{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--space-3);margin-top:var(--space-3)}
.pk-choice button{height:auto;min-height:72px;flex-direction:column;gap:var(--space-1);padding:var(--space-3);white-space:normal;text-align:center}
.pk-choice button small{font-weight:400;font-size:12px;opacity:.85}
#pk-status:empty{display:none}</style>
${list}
<section class="card" style="margin-top:var(--space-4)"><h2 class="with-icon" style="margin-top:0">${icon("plus", 16)}パスキーを登録</h2>
<label for="pk-name">名前（どの端末か分かるように）</label><input type="text" id="pk-name" maxlength="60" placeholder="例：iPhone、仕事の Mac">
<div class="pk-choice">
<button type="button" class="sub" data-pk-register="device">${icon("monitor", 20)}この端末に登録<small>この PC・スマホの指紋・顔認証・PIN を使う</small></button>
<button type="button" class="sub" data-pk-register="hybrid">${icon("qr-code", 20)}スマホに登録（QR コード）<small>PC に出る QR をスマホのカメラで読み取る</small></button>
</div>
<p class="flash error" id="pk-status" role="alert"></p>
<p class="muted" style="margin:var(--space-3) 0 0">パスキーはこのサイト（${h(rpId)}）専用です。管理画面は ${h(ctx.adminBaseUrl || ctx.publicBaseUrl)} で開いてください。QR コードでの登録・ログインには、スマホの Bluetooth をオンにしておく必要があります。iCloud キーチェーンや Google パスワード マネージャーに保存したパスキーは、同じアカウントの他の端末でも使えます。</p></section>
<script>(function(){${WEBAUTHN_CLIENT}
var st=document.getElementById('pk-status');
document.querySelectorAll('[data-pk-register]').forEach(function(b){b.addEventListener('click',function(){
st.textContent='';if(!window.PublicKeyCredential){st.textContent='このブラウザはパスキーに対応していません。';return}
var hybrid=b.dataset.pkRegister==='hybrid';b.disabled=true;
tzPost('/admin/passkeys/options',{hybrid:hybrid}).then(function(o){
o.publicKey.challenge=tzBuf(o.publicKey.challenge);o.publicKey.user.id=tzBuf(o.publicKey.user.id);
o.publicKey.excludeCredentials=o.publicKey.excludeCredentials.map(function(x){return {type:'public-key',id:tzBuf(x.id),transports:x.transports}});
return navigator.credentials.create({publicKey:o.publicKey})}).then(function(cr){
var r=cr.response;return tzPost('/admin/passkeys',{name:document.getElementById('pk-name').value,credential:{id:cr.id,rawId:tzB64(cr.rawId),type:cr.type,response:{clientDataJSON:tzB64(r.clientDataJSON),attestationObject:tzB64(r.attestationObject),transports:r.getTransports?r.getTransports():[]}}})
}).then(function(){location.href='/admin/passkeys?ok='+encodeURIComponent('パスキーを登録しました。次からはログイン画面の「パスキーでログイン」を使えます')}).catch(function(e){st.textContent=tzErr(e)}).finally(function(){b.disabled=false})})});
})();</script>`;
    return c.html(adminPage({ title: "パスキー", active: "/admin/passkeys", body, flash: flashFrom(c) }));
  });

  app.post("/passkeys/options", async (c) => {
    const ctx = await getCtx();
    const body = (await readJson<{ hybrid?: boolean }>(c)) ?? {};
    const challenge = await issueChallenge(ctx, "register");
    const existing = await ctx.db.query<{ credential_id: string; transports: string[] }>("SELECT credential_id, transports FROM admin_passkeys");
    const { rpId } = relyingParty(ctx, c);
    return c.json({
      publicKey: {
        rp: { id: rpId, name: "tsuzuri-mail 管理画面" },
        user: { id: USER_ID, name: "admin", displayName: "tsuzuri-mail 管理者" },
        challenge,
        pubKeyCredParams: COSE_ALGS.map((alg) => ({ type: "public-key", alg })),
        timeout: CHALLENGE_MINUTES * 60_000,
        attestation: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        excludeCredentials: existing.map((x) => ({ id: x.credential_id, transports: x.transports })),
        // スマホに登録するときは、ブラウザに QR コード（ハイブリッド）を先に出してもらう
        hints: body.hybrid ? ["hybrid"] : ["client-device"],
      },
    });
  });

  app.post("/passkeys", async (c) => {
    const ctx = await getCtx();
    const body = await readJson<{ name?: unknown; credential?: RegistrationResponseJSON }>(c);
    if (!body?.credential?.response) return c.json({ error: "登録の内容を読めませんでした" }, 400);
    const challenge = await consumeChallenge(ctx, body.credential.response.clientDataJSON, "register");
    if (!challenge) return c.json({ error: "時間が経ちすぎました。もう一度お試しください" }, 400);
    const { rpId, origins } = relyingParty(ctx, c);
    let cred;
    try {
      cred = verifyRegistration({ response: body.credential, expectedChallenge: challenge, expectedOrigins: origins, rpId });
    } catch (e) {
      if (e instanceof WebAuthnError) return c.json({ error: "パスキーを確認できませんでした" }, 400);
      throw e;
    }
    const name = (typeof body.name === "string" ? body.name : "").replace(/\s+/g, " ").trim().slice(0, 60) || `パスキー（${cred.transports.includes("hybrid") ? "スマホ" : "この端末"}）`;
    const rows = await ctx.db.query<{ id: string }>(
      `INSERT INTO admin_passkeys (credential_id, public_key, alg, sign_count, transports, name) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (credential_id) DO NOTHING RETURNING id`,
      [cred.credentialId, cred.publicKey, cred.alg, cred.signCount, cred.transports, name],
    );
    if (!rows[0]) return c.json({ error: "このパスキーはもう登録されています" }, 409);
    await audit(ctx.db, "passkey.create", rows[0].id);
    return c.json({ ok: true });
  });

  app.post("/passkeys/:id/rename", async (c) => {
    const ctx = await getCtx();
    const name = one(await readForm(c), "name").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) return back(c, "/admin/passkeys", "err", "名前を入れてください");
    await ctx.db.query("UPDATE admin_passkeys SET name = $2 WHERE id::text = $1", [c.req.param("id"), name]);
    return back(c, "/admin/passkeys", "ok", "名前を変えました");
  });

  app.post("/passkeys/:id/delete", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    await ctx.db.query("DELETE FROM admin_passkeys WHERE id::text = $1", [id]);
    await audit(ctx.db, "passkey.delete", id);
    return back(c, "/admin/passkeys", "ok", "パスキーを削除しました");
  });
}

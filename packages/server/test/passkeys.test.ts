import { base32Decode, generateTotpSecret, hashPassword, totp } from "@tsuzuri/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticator } from "../../core/src/security/webauthn-testkit.js";
import { createApp } from "../src/http/app.js";
import { createEnv, type TestEnv } from "./helpers.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;
const totpSecret = generateTotpSecret();
beforeAll(() => {
  passwordHash = hashPassword(PASSWORD);
});

let env: TestEnv;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  env = await createEnv();
  env.ctx.admin = { passwordHash, totpSecret };
  app = createApp(async () => env.ctx, { enqueue: async () => {} });
});

const BASE = "https://mail.example.com";
const json = (path: string, body: unknown, cookie = "", site = "same-origin") =>
  app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": site, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? "" : JSON.stringify(body),
  });

async function passwordLogin(): Promise<string> {
  const res = await app.request(`${BASE}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ password: PASSWORD, code: totp(base32Decode(totpSecret), env.ctx.now()) }).toString(),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function register(cookie: string, a: ReturnType<typeof authenticator>, hybrid = false) {
  const opts = (await (await json("/admin/passkeys/options", { hybrid }, cookie)).json()) as {
    publicKey: { challenge: string; rp: { id: string }; hints: string[]; authenticatorSelection: { userVerification: string; residentKey: string } };
  };
  expect(opts.publicKey.rp.id).toBe("mail.example.com");
  expect(opts.publicKey.hints).toEqual(hybrid ? ["hybrid"] : ["client-device"]);
  expect(opts.publicKey.authenticatorSelection).toMatchObject({ userVerification: "required", residentKey: "required" });
  return json("/admin/passkeys", { name: "iPhone", credential: a.register(opts.publicKey.challenge) }, cookie);
}

async function loginWith(a: ReturnType<typeof authenticator>, o: Parameters<ReturnType<typeof authenticator>["login"]>[1] = {}) {
  const opts = (await (await json("/admin/passkey/login/options", undefined)).json()) as { challenge: string; rpId: string };
  return json("/admin/passkey/login", a.login(opts.challenge, o));
}

describe("admin passkeys", () => {
  it("registers a passkey while logged in and then logs in with it", async () => {
    const cookie = await passwordLogin();
    const a = authenticator("ec");
    const reg = await register(cookie, a, true);
    expect(reg.status).toBe(200);
    const [pk] = await env.ctx.db.query<{ name: string; transports: string[] }>("SELECT name, transports FROM admin_passkeys");
    expect(pk).toEqual({ name: "iPhone", transports: ["hybrid", "internal"] });
    const page = await (await app.request(`${BASE}/admin/passkeys`, { headers: { cookie } })).text();
    expect(page).toContain("iPhone");
    expect(page).toContain("スマホ（QR）");

    const res = await loginWith(a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect: "/admin" });
    const session = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(session).toMatch(/^tz_admin=/);
    expect((await app.request(`${BASE}/admin`, { headers: { cookie: session } })).status).toBe(200);
    const [used] = await env.ctx.db.query<{ last_used_at: Date | null }>("SELECT last_used_at FROM admin_passkeys");
    expect(used!.last_used_at).not.toBeNull();
  });

  it("cannot register without a session, and rejects unknown keys, replays and cross-site posts", async () => {
    expect((await json("/admin/passkeys/options", {})).status).toBe(401);
    const cookie = await passwordLogin();
    const a = authenticator("ed");
    expect((await register(cookie, a)).status).toBe(200);

    // 登録していない鍵
    expect((await loginWith(authenticator("ec"))).status).toBe(401);
    // 同じチャレンジは 2 回使えない
    const opts = (await (await json("/admin/passkey/login/options", undefined)).json()) as { challenge: string };
    const body = a.login(opts.challenge);
    expect((await json("/admin/passkey/login", body)).status).toBe(200);
    expect((await json("/admin/passkey/login", body)).status).toBe(401);
    // 他のサイトからは受け付けない
    expect((await json("/admin/passkey/login/options", undefined, "", "cross-site")).status).toBe(403);
  });

  it("locks after repeated failures like the password login", async () => {
    const cookie = await passwordLogin();
    await register(cookie, authenticator("ec"));
    const stranger = authenticator("ec");
    for (let i = 0; i < 5; i++) await loginWith(stranger);
    expect((await json("/admin/passkey/login/options", undefined)).status).toBe(429);
  });

  it("shows the passkey buttons on the login page", async () => {
    const html = await (await app.request(`${BASE}/admin/login`)).text();
    expect(html).toContain("パスキーでログイン");
    expect(html).toContain("QR コードを読み取ってログイン");
  });
});

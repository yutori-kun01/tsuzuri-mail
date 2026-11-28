import { base32Decode, generateTotpSecret, hashPassword, totp } from "@tsuzuri/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { sendMessage } from "../src/services/sending.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { subscribe } from "../src/services/subscription.js";
import { createEnv, type TestEnv } from "./helpers.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;
const totpSecret = generateTotpSecret();
beforeAll(() => {
  passwordHash = hashPassword(PASSWORD);
});

const BASE = "https://mail.example.com";

async function setup(env: TestEnv) {
  env.ctx.admin = { passwordHash, totpSecret };
  const app = createApp(async () => env.ctx, { enqueue: async () => {} });
  const form = (path: string, data: Record<string, string>, cookie = "") =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(data).toString(),
    });
  const res = await form("/admin/login", { password: PASSWORD, code: totp(base32Decode(totpSecret), env.ctx.now()) });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { app, form: (p: string, d: Record<string, string>) => form(p, d, cookie), cookie };
}

describe("data transfer", () => {
  it("exports with a one-time key and imports into a fresh environment", async () => {
    // 引っ越し元：シナリオ・読者・送信・開封・設定
    const src = await createEnv();
    const a = await setup(src);
    const r = await a.form("/admin/sequences", { name: "特典", slug: "gift" });
    const seqId = /\/admin\/sequences\/([0-9a-f-]+)/.exec(r.headers.get("location") ?? "")![1]!;
    await a.form(`/admin/sequences/${seqId}/steps`, { timing: "days", delay_days: "1", send_time: "08:30", subject: "ようこそ", body: "[記事](https://example.com/a)", format: "markdown" });
    await a.form(`/admin/sequences/${seqId}/steps`, { timing: "now", subject: "すぐ", body: "本文", format: "markdown" });
    await a.form(`/admin/sequences/${seqId}/status`, { status: "active" });
    await subscribe(src.ctx, { formSlug: "gift", email: "reader@example.com", name: "山田" }, { allowInactiveForm: true });
    src.advanceDays(2);
    for (const id of await scheduleDueSteps(src.ctx)) await sendMessage(src.ctx, id);
    const [m] = await src.ctx.db.query<{ id: string; contact_id: string }>("SELECT id, contact_id FROM messages LIMIT 1");
    await src.ctx.db.query("INSERT INTO events (contact_id, message_id, type) VALUES ($1, $2, 'open')", [m!.contact_id, m!.id]);
    await src.ctx.db.query(`INSERT INTO app_settings (id, settings) VALUES (1, '{"senderName":"引っ越し元"}') ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`);

    const a2 = await setup(src); // 時計を進めたのでログインし直す
    const ex = await a2.form("/admin/transfer/export", { history: "1" });
    const page = await ex.text();
    const keyText = /TZK1-[A-Z2-7-]+/.exec(page)![0];
    const exportId = /\/admin\/transfer\/exports\/([0-9a-f-]+)/.exec(page)![1]!;
    const fileRes = await a2.app.request(`${BASE}/admin/transfer/exports/${exportId}`, { headers: { cookie: a2.cookie } });
    expect(fileRes.headers.get("content-disposition")).toMatch(/attachment; filename="tsuzuri-transfer-\d+\.tzx"/);
    const file = Buffer.from(await fileRes.arrayBuffer());
    expect(file.includes(Buffer.from("reader@example.com"))).toBe(false);
    // キーはサーバーに残らない
    const [stored] = await src.ctx.db.query<{ summary: object }>("SELECT summary FROM data_exports");
    expect(JSON.stringify(stored)).not.toContain(keyText);

    // 引っ越し先：別の DB。既にあるデータは置き換わる
    const dst = await createEnv();
    const b = await setup(dst);
    await b.form("/admin/tags", { name: "消えるタグ" });
    const upload = async (key: string, confirm = true) => {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array(file)], "t.tzx"));
      fd.append("key", key);
      if (confirm) fd.append("confirm", "1");
      return b.app.request(`${BASE}/admin/transfer/import`, { method: "POST", headers: { cookie: b.cookie, "sec-fetch-site": "same-origin" }, body: fd });
    };
    // 違うキー・確認なしでは何も変わらない
    const wrong = await upload("TZK1-" + "A".repeat(58));
    expect(decodeURIComponent(wrong.headers.get("location") ?? "")).toContain("暗号化キー");
    expect(await dst.ctx.db.query("SELECT 1 FROM tags WHERE name = '消えるタグ'")).toHaveLength(1);
    expect((await upload(keyText, false)).status).toBe(303);

    const ok = await upload(keyText.toLowerCase().replace("tzk1-", "TZK1-"));
    expect(ok.status).toBe(200);
    const done = await ok.text();
    expect(done).toContain("読み込みました");
    expect(done).not.toContain("TOKEN_SECRET が引っ越し元と違います");

    const count = async (env: TestEnv, t: string) => (await env.ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n;
    for (const t of ["contacts", "channels", "consents", "tags", "contact_tags", "sequences", "sequence_steps", "forms", "enrollments", "messages", "events", "footers"]) {
      expect([t, await count(dst, t)]).toEqual([t, await count(src, t)]);
    }
    expect(await dst.ctx.db.query("SELECT 1 FROM tags WHERE name = '消えるタグ'")).toHaveLength(0);
    const [st] = await dst.ctx.db.query<{ send_time: string }>("SELECT send_time::text AS send_time FROM sequence_steps WHERE subject = 'ようこそ'");
    expect(st!.send_time).toBe("08:30:00");
    expect(dst.ctx.settings.senderName).toBe("引っ越し元");
    // 自動採番は続きから
    await dst.ctx.db.query("INSERT INTO events (contact_id, type) VALUES ($1, 'open')", [m!.contact_id]);
    // 画面もそのまま使える
    const seqPage = await b.app.request(`${BASE}/admin/sequences/${seqId}`, { headers: { cookie: b.cookie } });
    expect(await seqPage.text()).toContain("ようこそ");
  });

  it("warns when TOKEN_SECRET differs", async () => {
    const src = await createEnv();
    const a = await setup(src);
    const page = await (await a.form("/admin/transfer/export", {})).text();
    const keyText = /TZK1-[A-Z2-7-]+/.exec(page)![0];
    const id = /\/admin\/transfer\/exports\/([0-9a-f-]+)/.exec(page)![1]!;
    const file = Buffer.from(await (await a.app.request(`${BASE}/admin/transfer/exports/${id}`, { headers: { cookie: a.cookie } })).arrayBuffer());
    const dst = await createEnv();
    dst.ctx.secret = "x".repeat(40);
    const b = await setup(dst);
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(file)], "t.tzx"));
    fd.append("key", keyText);
    fd.append("confirm", "1");
    const res = await b.app.request(`${BASE}/admin/transfer/import`, { method: "POST", headers: { cookie: b.cookie, "sec-fetch-site": "same-origin" }, body: fd });
    expect(await res.text()).toContain("TOKEN_SECRET が引っ越し元と違います");
  });
});

describe("SES cost estimate", () => {
  it("shows actual sends and an estimate, and saves the price and rate", async () => {
    const env = await createEnv();
    const a = await setup(env);
    const page = await (await a.app.request(`${BASE}/admin/costs?readers=10000&broadcasts=4&signups=300&steps=7&confirm=1`, { headers: { cookie: a.cookie } })).text();
    expect(page).toContain("42,400");
    expect(page).toContain("$4.24");
    expect(page).toContain("https://aws.amazon.com/ses/pricing/");
    await a.form("/admin/costs", { price: "0.2", usdJpy: "100" });
    expect(env.ctx.settings.sesPricePer1000Usd).toBe(0.2);
    const page2 = await (await a.app.request(`${BASE}/admin/costs?readers=10000&broadcasts=4&signups=300&steps=7&confirm=1`, { headers: { cookie: a.cookie } })).text();
    expect(page2).toContain("$8.48");
    expect(page2).toContain("約 848 円");
    await a.form("/admin/costs", { price: "0.2", usdJpy: "" });
    expect(env.ctx.settings.usdJpy).toBeUndefined();
  });
});

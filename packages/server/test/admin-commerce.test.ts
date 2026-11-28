import { base32Decode, generateTotpSecret, generateTransferKey, hashPassword, totp } from "@tsuzuri/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { createEnv, memoryBucket, type TestEnv } from "./helpers.js";

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

function post(path: string, data: Record<string, string>, cookie?: string) {
  return app.request(`https://mail.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(data).toString(),
  });
}
async function login(): Promise<string> {
  const res = await post("/admin/login", { password: PASSWORD, code: totp(base32Decode(totpSecret), env.ctx.now()) });
  expect(res.status).toBe(303);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const get = (path: string, cookie: string) => app.request(`https://mail.example.com${path}`, { headers: { cookie } });

describe("管理画面：販売", () => {
  it("商品を作り、特商法の表記を保存すると公開ページに出る", async () => {
    const cookie = await login();
    const page = await (await get("/admin/commerce", cookie)).text();
    expect(page).toContain("特定商取引法に基づく表記が未入力です");
    expect(page).toContain("https://mail.example.com/hooks/stripe");

    const [seq] = await env.ctx.db.query<{ id: string }>("INSERT INTO sequences (slug, name, status, purpose) VALUES ('p', '講座のお届け', 'active', 'product') RETURNING id");
    const res = await post("/admin/commerce/products", { name: "文章講座", code: "course-a", price_amount: "3000", status: "active", sequence_id: seq!.id, tag: "購入:講座" }, cookie);
    expect(res.status).toBe(303);
    const [p] = await env.ctx.db.query<{ code: string; price_amount: number; sequence_id: string; tag_id: string | null }>("SELECT code, price_amount, sequence_id, tag_id FROM products");
    expect(p).toMatchObject({ code: "course-a", price_amount: 3000, sequence_id: seq!.id });
    expect(p!.tag_id).not.toBeNull();
    // 識別名の形が違う・重複は断る
    expect((await post("/admin/commerce/products", { name: "x", code: "Bad Code" }, cookie)).headers.get("location")).toContain("err=");
    expect((await post("/admin/commerce/products", { name: "x", code: "course-a" }, cookie)).headers.get("location")).toContain("err=");

    await post("/admin/commerce/legal", { sellerName: "つづり", disclosureOnRequest: "1", contact: "https://example.com/c", price: "各ページに表示", extraFees: "なし", paymentMethods: "クレジットカード", paymentTiming: "注文時", deliveryTiming: "すぐ", returnPolicy: "返品不可" }, cookie);
    const legal = await (await app.request("https://mail.example.com/legal/commerce")).text();
    expect(legal).toContain("つづり");
    expect(legal).toContain("返品不可");
    expect(await (await get("/admin/commerce", cookie)).text()).not.toContain("未入力です");
    // ほかの設定は消えない
    const [s] = await env.ctx.db.query<{ settings: Record<string, unknown> }>("SELECT settings FROM app_settings WHERE id = 1");
    expect(s!.settings.commerce).toBeTruthy();
  });

  it("シナリオの使い道に「商品を届ける」を選べる", async () => {
    const cookie = await login();
    const [seq] = await env.ctx.db.query<{ id: string }>("INSERT INTO sequences (slug, name) VALUES ('p', '講座') RETURNING id");
    await post(`/admin/sequences/${seq!.id}`, { name: "講座", status: "draft", purpose: "product" }, cookie);
    expect((await env.ctx.db.query<{ purpose: string }>("SELECT purpose FROM sequences"))[0]!.purpose).toBe("product");
  });

  it("自動化のきっかけに「商品を買ったとき」がある", async () => {
    const cookie = await login();
    const [p] = await env.ctx.db.query<{ id: string }>("INSERT INTO products (code, name) VALUES ('a', '講座A') RETURNING id");
    expect(await (await get("/admin/automations", cookie)).text()).toContain("商品を買ったとき");
    await post("/admin/automations", { trigger_type: "purchased", trigger_product: p!.id, action_type: "add_tag", action_tag: "購入者" }, cookie);
    const [r] = await env.ctx.db.query<{ name: string }>("SELECT name FROM automation_rules");
    expect(r!.name).toContain("講座A");
  });
});

describe("管理画面：バックアップ", () => {
  it("一覧と容量の見込みを出し、今すぐ取れる", async () => {
    const bucket = memoryBucket();
    env.ctx.backups = { bucket, key: generateTransferKey().key, keepDays: 30 };
    const cookie = await login();
    expect(await (await get("/admin/backups", cookie)).text()).toContain("まだバックアップがありません");
    expect((await post("/admin/backups/run", {}, cookie)).status).toBe(303);
    const html = await (await get("/admin/backups", cookie)).text();
    expect(html).toContain("2026-11-13");
    expect(html).toContain("R2 の無料枠");
    const dl = await get("/admin/backups/2026-11-13.tzb", cookie);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 4).toString()).toBe("TZB1");
    expect((await get("/admin/backups/../x.tzb", cookie)).status).toBe(404);
  });

  it("鍵が無ければ取らないと知らせる", async () => {
    env.ctx.backups = { bucket: memoryBucket(), keepDays: 30 };
    const cookie = await login();
    expect(await (await get("/admin/backups", cookie)).text()).toContain("BACKUP_ENCRYPTION_KEY");
  });
});

describe("パスキーだけでログイン", () => {
  it("パスワードのログインを止められる（パスキーが無い間は止めない）", async () => {
    env.ctx.admin = { passwordHash, totpSecret, passwordLogin: false };
    // パスキーが無いので、締め出さないようにパスワードで入れる
    await login();
    await env.ctx.db.query("INSERT INTO admin_passkeys (credential_id, public_key, alg, name) VALUES ('c', 'k', -7, 'テスト')");
    const page = await (await app.request("https://mail.example.com/admin/login")).text();
    expect(page).toContain("パスワードでのログインは止めています");
    expect(page).not.toContain('name="password"');
    const res = await post("/admin/login", { password: PASSWORD, code: totp(base32Decode(totpSecret), env.ctx.now()) });
    expect(res.status).toBe(403);
  });
});

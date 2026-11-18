import { base32Decode, generateTotpSecret, hashPassword, totp } from "@tsuzuri/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { addContactManually } from "../src/services/readers.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { sendMessage } from "../src/services/sending.js";
import { createEnv, type TestEnv } from "./helpers.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;
const totpSecret = generateTotpSecret();
beforeAll(() => {
  passwordHash = hashPassword(PASSWORD);
});

let env: TestEnv;
let app: ReturnType<typeof createApp>;
let cookie: string;

const form = (data: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
};
const post = (path: string, data: Record<string, string | string[]>) =>
  app.request(`https://mail.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
    body: form(data),
  });
const get = async (path: string) => (await app.request(`https://mail.example.com${path}`, { headers: { cookie } })).text();
const flash = (res: Response) => decodeURIComponent(res.headers.get("location") ?? "");

beforeEach(async () => {
  env = await createEnv();
  env.ctx.admin = { passwordHash, totpSecret };
  app = createApp(async () => env.ctx, { enqueue: async () => {} });
  cookie = "";
  const res = await post("/admin/login", { password: PASSWORD, code: totp(base32Decode(totpSecret), env.ctx.now()) });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
});

describe("footers", () => {
  it("refuses a footer without the legal parts and uses the chosen footer when sending", async () => {
    const bad = await post("/admin/footers", { name: "x", body: "%sender% だけ" });
    expect(flash(bad)).toContain("%cancel%");

    await post("/admin/footers", { name: "短い", body: "%sender%\n[停止](%cancel%) [情報](%sender_info%)" });
    const [short] = await env.ctx.db.query<{ id: string }>("SELECT id FROM footers WHERE name = '短い'");

    const [seq] = await env.ctx.db.query<{ id: string }>(
      "INSERT INTO sequences (slug, name, status, footer_id) VALUES ('f', 'F', 'active', $1) RETURNING id",
      [short!.id],
    );
    await env.ctx.db.query("INSERT INTO sequence_steps (sequence_id, position, delay_minutes, subject, body_markdown) VALUES ($1, 1, 0, 's', 'b')", [seq!.id]);
    await addContactManually(env.ctx, { email: "r@example.com", evidence: "t", sequenceId: seq!.id });
    const [id] = await scheduleDueSteps(env.ctx);
    await sendMessage(env.ctx, id!);
    const sent = env.provider.sent.at(-1)!;
    expect(sent.html).toContain("/legal");
    expect(sent.html).not.toContain("お問い合わせ："); // 「標準」ではなく選んだフッター
    expect(sent.text).toContain("つづり通信");
  });
});

describe("scenarios and forms", () => {
  it("creates a paired form with a scenario, and starts/stops it in one click", async () => {
    const res = await post("/admin/sequences", { name: "SEO 特典", slug: "" });
    expect(flash(res)).toContain("シナリオと登録フォームを作りました");
    const [f] = await env.ctx.db.query<{ id: string; active: boolean; sequence_id: string; slug: string }>(
      "SELECT f.id, f.active, f.sequence_id, f.slug FROM forms f JOIN sequences s ON s.id = f.sequence_id WHERE s.name = 'SEO 特典'",
    );
    expect(f?.active).toBe(false);
    expect(f!.slug).toMatch(/^s-/);
    const [tag] = await env.ctx.db.query<{ name: string }>("SELECT t.name FROM forms f JOIN tags t ON t.id = f.tag_id WHERE f.id = $1", [f!.id]);
    expect(tag!.name).toBe("SEO 特典");

    const on = await post(`/admin/forms/${f!.id}/active`, { active: "1", back: `/admin/sequences/${f!.sequence_id}` });
    expect(flash(on)).toContain("シナリオがまだ有効ではない");
    expect((await env.ctx.db.query<{ active: boolean }>("SELECT active FROM forms WHERE id = $1", [f!.id]))[0]!.active).toBe(true);
    expect(await get(`/admin/sequences/${f!.sequence_id}`)).toContain("登録してもステップメールは届きません");

    await post(`/admin/forms/${f!.id}/active`, { active: "0" });
    expect((await env.ctx.db.query<{ active: boolean }>("SELECT active FROM forms WHERE id = $1", [f!.id]))[0]!.active).toBe(false);
  });

  it("saves the three timing patterns from the step editor", async () => {
    const [seq] = await env.ctx.db.query<{ id: string }>("INSERT INTO sequences (slug, name) VALUES ('q', 'Q') RETURNING id");
    const base = { subject: "s", body: "b", format: "markdown" };
    await post(`/admin/sequences/${seq!.id}/steps`, { ...base, timing: "now" });
    await post(`/admin/sequences/${seq!.id}/steps`, { ...base, timing: "after", after_value: "3", after_unit: "hours" });
    await post(`/admin/sequences/${seq!.id}/steps`, { ...base, timing: "days", delay_days: "2", send_time: "08:00" });
    const rows = await env.ctx.db.query<{ delay_days: number; send_time: string | null; delay_minutes: number | null }>(
      "SELECT delay_days, send_time::text AS send_time, delay_minutes FROM sequence_steps WHERE sequence_id = $1 ORDER BY position",
      [seq!.id],
    );
    expect(rows).toEqual([
      { delay_days: 0, send_time: null, delay_minutes: 0 },
      { delay_days: 0, send_time: null, delay_minutes: 180 },
      { delay_days: 2, send_time: "08:00:00", delay_minutes: null },
    ]);
    const page = await get(`/admin/sequences/${seq!.id}`);
    expect(page).toContain("登録後すぐ");
    expect(page).toContain("前の通から 3 時間後");
  });
});

describe("tags", () => {
  it("adds and removes a tag for the selected readers", async () => {
    const a = await addContactManually(env.ctx, { email: "a@example.com", evidence: "t" });
    const b = await addContactManually(env.ctx, { email: "b@example.com", evidence: "t" });
    if (a.status !== "added" || b.status !== "added") throw new Error("setup");
    const added = await post("/admin/readers/bulk-tag", { ids: [a.contactId, b.contactId], tag: "VIP", op: "add" });
    expect(flash(added)).toContain("2 人にタグ「VIP」を付けました");
    const removed = await post("/admin/readers/bulk-tag", { ids: [a.contactId], tag: "VIP", op: "remove" });
    expect(flash(removed)).toContain("1 人からタグ「VIP」を外しました");
    const left = await env.ctx.db.query("SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.name = 'VIP'");
    expect(left).toHaveLength(1);
  });
});

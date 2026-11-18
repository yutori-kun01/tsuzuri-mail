import { base32Decode, generateTotpSecret, hashPassword, totp } from "@tsuzuri/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { decodeCsv, importContacts } from "../src/services/import.js";
import { addContactManually, inviteByForm } from "../src/services/readers.js";
import { unsubscribe } from "../src/services/subscription.js";
import { createEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await createEnv();
});

const statusOf = async (email: string) =>
  (
    await env.ctx.db.query<{ status: string }>(
      "SELECT c.status FROM contacts c JOIN channels ch ON ch.contact_id = c.id WHERE ch.address = $1",
      [email],
    )
  )[0]?.status;
const tagsOf = async (email: string) =>
  (
    await env.ctx.db.query<{ name: string }>(
      `SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id JOIN channels ch ON ch.contact_id = ct.contact_id
        WHERE ch.address = $1 ORDER BY t.name`,
      [email],
    )
  ).map((r) => r.name);

async function makeForm(active: boolean): Promise<string> {
  const [f] = await env.ctx.db.query<{ id: string }>(
    "INSERT INTO forms (slug, name, consent_text_version, active) VALUES ('invite-test', '招待テスト', 'v1', $1) RETURNING id",
    [active],
  );
  return f!.id;
}

describe("CSV import", () => {
  it("reads Japanese headers, Shift_JIS, a tags column and reports duplicates without writing on dry run", async () => {
    // Excel の日本語版が書き出す Shift_JIS（「メールアドレス,名前,タグ」…）
    const sjis = new Uint8Array([
      0x83, 0x81, 0x81, 0x5b, 0x83, 0x8b, 0x83, 0x41, 0x83, 0x68, 0x83, 0x8c, 0x83, 0x58, 0x2c, 0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x83, 0x5e, 0x83, 0x4f, 0x0a,
    ]);
    expect(decodeCsv(sjis)).toBe("メールアドレス,名前,タグ\n");

    const csv = "メールアドレス,名前,タグ\nA@example.com,山田,VIP;セミナー\nnot-an-email,鈴木,\na@example.com,重複,\nb@example.com,,\n";
    const dry = await importContacts(env.ctx.db, csv, { label: "old", evidence: "移行", tags: ["移行組"], dryRun: true });
    expect([dry.imported, dry.skippedExisting, dry.duplicates, dry.invalid.length]).toEqual([2, 0, 1, 1]);
    expect(dry.rows[0]).toMatchObject({ email: "a@example.com", name: "山田", tags: ["移行組", "VIP", "セミナー"], result: "add" });
    expect(await statusOf("a@example.com")).toBeUndefined();

    const done = await importContacts(env.ctx.db, csv, { label: "old", evidence: "移行", tags: ["移行組"] });
    expect(done.imported).toBe(2);
    expect(await statusOf("a@example.com")).toBe("active");
    expect(await tagsOf("a@example.com")).toEqual(["old", "VIP", "セミナー", "移行組"].sort());

    // 2 回目は既存としてスキップし、状態は変えない
    await unsubscribe(env.ctx, (await env.ctx.db.query<{ contact_id: string }>("SELECT contact_id FROM channels WHERE address = 'b@example.com'"))[0]!.contact_id);
    const again = await importContacts(env.ctx.db, csv, { label: "old", evidence: "移行" });
    expect([again.imported, again.skippedExisting]).toEqual([0, 2]);
    expect(await statusOf("b@example.com")).toBe("unsubscribed");
  });
});

describe("manual add", () => {
  it("adds a consented reader with tags and a consent record", async () => {
    const r = await addContactManually(env.ctx, { email: "New@Example.com", name: "新井", evidence: "名刺交換で口頭同意", tags: ["イベント"] });
    expect(r.status).toBe("added");
    expect(await statusOf("new@example.com")).toBe("active");
    expect(await tagsOf("new@example.com")).toEqual(["イベント"]);
    const [consent] = await env.ctx.db.query<{ method: string; evidence: { evidence: string } }>("SELECT method, evidence FROM consents");
    expect(consent).toMatchObject({ method: "manual", evidence: { evidence: "名刺交換で口頭同意" } });
  });

  it("never brings back readers who unsubscribed", async () => {
    const r = await addContactManually(env.ctx, { email: "x@example.com", evidence: "e" });
    if (r.status !== "added") throw new Error("setup");
    await unsubscribe(env.ctx, r.contactId);
    const again = await addContactManually(env.ctx, { email: "x@example.com", evidence: "e", tags: ["戻す"] });
    expect(again.status).toBe("blocked");
    expect(await statusOf("x@example.com")).toBe("unsubscribed");
    const invite = await inviteByForm(env.ctx, await makeForm(true), "x@example.com");
    expect(invite.status).toBe("blocked");
  });

  it("can send a confirmation email through a form that is not accepting sign-ups", async () => {
    const formId = await makeForm(false);
    const r = await inviteByForm(env.ctx, formId, "y@example.com", "吉田");
    expect(r.status).toBe("confirmation-sent");
    expect(await statusOf("y@example.com")).toBe("pending");
  });
});

describe("admin pages for adding readers", () => {
  const PASSWORD = "correct horse battery staple";
  let passwordHash: string;
  const totpSecret = generateTotpSecret();
  beforeAll(() => {
    passwordHash = hashPassword(PASSWORD);
  });

  async function setup() {
    env.ctx.admin = { passwordHash, totpSecret };
    const queued: string[] = [];
    const app = createApp(async () => env.ctx, { enqueue: async (ids) => void queued.push(...ids) });
    const send = (path: string, body: BodyInit, type?: string, cookie?: string) =>
      app.request(`https://mail.example.com${path}`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", ...(type ? { "content-type": type } : {}), ...(cookie ? { cookie } : {}) },
        body,
      });
    const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
    const login = await send("/admin/login", form({ password: PASSWORD, code: totp(base32Decode(totpSecret), env.ctx.now()) }), "application/x-www-form-urlencoded");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    return { app, send, form, cookie, queued };
  }

  it("adds one reader, invites another, and imports a CSV after a preview", async () => {
    const { app, send, form, cookie, queued } = await setup();
    const page = await (await app.request("https://mail.example.com/admin/readers/new", { headers: { cookie } })).text();
    expect(page).toContain("どのように同意を得たか");

    // 同意の記録が無いと追加できない
    const noEvidence = await send("/admin/readers/new", form({ mode: "direct", email: "m@example.com", evidence: "" }), "application/x-www-form-urlencoded", cookie);
    expect(decodeURIComponent(noEvidence.headers.get("location") ?? "")).toContain("同意を得たか");
    const added = await send("/admin/readers/new", form({ mode: "direct", email: "m@example.com", evidence: "対面で同意", tags: "対面" }), "application/x-www-form-urlencoded", cookie);
    expect(added.status).toBe(303);
    expect(await statusOf("m@example.com")).toBe("active");

    const formId = await makeForm(true);
    await send("/admin/readers/new", form({ mode: "invite", form_id: formId, email: "i@example.com" }), "application/x-www-form-urlencoded", cookie);
    expect(queued).toHaveLength(1);

    const fd = new FormData();
    fd.append("file", new File(["email,name\nc1@example.com,一\nc2@example.com,二\nm@example.com,既存\n"], "list.csv", { type: "text/csv" }));
    fd.append("label", "seminar");
    fd.append("evidence", "セミナーの申込フォームで同意");
    const preview = await (await send("/admin/readers/import/preview", fd, undefined, cookie)).text();
    expect(preview).toContain("2 人を取り込む");
    expect(await statusOf("c1@example.com")).toBeUndefined();

    const csv = /<textarea name="csv" hidden>([\s\S]*?)<\/textarea>/.exec(preview)![1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<");
    const noCheck = await send("/admin/readers/import", form({ csv, label: "seminar", evidence: "x" }), "application/x-www-form-urlencoded", cookie);
    expect(noCheck.status).toBe(303);
    const done = await (await send("/admin/readers/import", form({ csv, label: "seminar", evidence: "x", confirm: "1" }), "application/x-www-form-urlencoded", cookie)).text();
    expect(done).toContain("2 人を取り込みました");
    expect(await tagsOf("c2@example.com")).toEqual(["seminar"]);
  });
});

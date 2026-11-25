import { base32Decode, generateTotpSecret, hashPassword, totp } from "@tsuzuri/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { launchDueBroadcasts } from "../src/services/broadcasts.js";
import { importContacts } from "../src/services/import.js";
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

const code = () => totp(base32Decode(totpSecret), env.ctx.now());

function post(path: string, data: Record<string, string | string[]>, cookie?: string, site = "same-origin") {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return app.request(`https://mail.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": site,
      ...(cookie ? { cookie } : {}),
    },
    body: body.toString(),
  });
}

async function loginCookie(): Promise<string> {
  const res = await post("/admin/login", { password: PASSWORD, code: code() });
  expect(res.status).toBe(303);
  const set = res.headers.get("set-cookie") ?? "";
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Strict");
  expect(set).toContain("Secure");
  return set.split(";")[0]!;
}

const get = (path: string, cookie: string) => app.request(`https://mail.example.com${path}`, { headers: { cookie } });

describe("admin login", () => {
  it("redirects to the login page without a session", async () => {
    const res = await app.request("https://mail.example.com/admin");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  it("requires both the password and the authenticator code", async () => {
    expect((await post("/admin/login", { password: PASSWORD, code: "000000" })).status).toBe(401);
    expect((await post("/admin/login", { password: "wrong password!!", code: code() })).status).toBe(401);
    const cookie = await loginCookie();
    const home = await get("/admin", cookie);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("配信中の読者");
  });

  it("locks out after repeated failures", async () => {
    for (let i = 0; i < 4; i++) await post("/admin/login", { password: "nope nope nope", code: "000000" });
    expect((await post("/admin/login", { password: "nope nope nope", code: "000000" })).status).toBe(429);
    // 正しい情報でもロック中はログインできない
    expect((await post("/admin/login", { password: PASSWORD, code: code() })).status).toBe(429);
    env.advanceDays(1);
    expect((await post("/admin/login", { password: PASSWORD, code: code() })).status).toBe(303);
  });

  it("rejects cross-site writes and forged cookies", async () => {
    const cookie = await loginCookie();
    expect((await post("/admin/variables", { key: "x", value: "y" }, cookie, "cross-site")).status).toBe(403);
    expect((await get("/admin", "tz_admin=forged.value")).status).toBe(303);
  });

  it("expires sessions after 12 hours", async () => {
    const cookie = await loginCookie();
    env.setNow(new Date(env.ctx.now().getTime() + 13 * 3_600_000));
    expect((await get("/admin", cookie)).status).toBe(303);
  });
});

describe("admin broadcasts", () => {
  it("creates, previews, test-sends, schedules and sends to the chosen segment", async () => {
    const cookie = await loginCookie();
    await importContacts(env.ctx.db, "email\na@example.com\nb@example.com\n", { label: "old", evidence: "test" });
    await env.ctx.db.query(
      "UPDATE contacts SET tier = 'hot' WHERE id = (SELECT contact_id FROM channels WHERE address = 'a@example.com')",
    );

    // タグの一覧とホームの期間切り替え
    expect(await (await get("/admin/tags", cookie)).text()).toContain(">old<");
    const home = await (await get("/admin?range=7", cookie)).text();
    expect(home).toContain("新規登録（7 日）");
    expect(home).not.toContain("NaN");

    // 未登録の置き換え文字は保存できない
    const bad = await post("/admin/broadcasts", { subject: "s", body: "%cancell%", format: "markdown" }, cookie);
    expect(decodeURIComponent(bad.headers.get("location") ?? "")).toContain("未登録の置き換え文字");

    const res = await post("/admin/broadcasts", { subject: "%name%さんへ", body: "本文 [記事](https://example.org)", format: "markdown", tiers: ["hot"] }, cookie);
    const location = res.headers.get("location") ?? "";
    const id = /\/admin\/broadcasts\/([0-9a-f-]+)/.exec(location)![1]!;

    const page = await (await get(`/admin/broadcasts/${id}`, cookie)).text();
    expect(page).toContain("宛先 <b>1</b> 人");

    // 入力中の内容でプレビューと人数がその場で変わる（保存はしない）
    const live = await (await post("/admin/broadcasts/live", { subject: "%name%さん、こんにちは", body: "下書き", format: "markdown" }, cookie)).text();
    expect(live).toContain("山田さん、こんにちは");
    expect(live).toContain("宛先 <b>2</b> 人");
    const liveBad = await (await post("/admin/broadcasts/live", { subject: "s", body: "%cancell%", format: "markdown" }, cookie)).text();
    expect(liveBad).toContain("未登録の置き換え文字");

    // htmx は自分のサーバーから配る
    const js = await get("/admin/assets/htmx.min.js", cookie);
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("max-age");

    const preview = await get(`/admin/broadcasts/${id}/preview`, cookie);
    expect(await preview.text()).toContain("山田さんへ");
    expect(preview.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");

    // テスト送信は設定の宛先だけに送る
    const noTarget = await post(`/admin/broadcasts/${id}/test`, {}, cookie);
    expect(decodeURIComponent(noTarget.headers.get("location") ?? "")).toContain("テスト送信先");
    env.ctx.settings.testRecipients = ["owner@example.com"];
    await env.ctx.db.query("INSERT INTO app_settings (id, settings) VALUES (1, $1)", [JSON.stringify({ testRecipients: ["owner@example.com"] })]);
    await post(`/admin/broadcasts/${id}/test`, {}, cookie);
    expect(env.provider.sent.map((m) => [m.to, m.subject])).toEqual([["owner@example.com", "[テスト] 山田さんへ"]]);

    // 確認のチェックなしでは予約できない
    expect(decodeURIComponent((await post(`/admin/broadcasts/${id}/schedule`, {}, cookie)).headers.get("location") ?? "")).toContain("確認のチェック");
    await post(`/admin/broadcasts/${id}/schedule`, { confirm: "1" }, cookie);
    const ids = await launchDueBroadcasts(env.ctx);
    expect(ids).toHaveLength(1);

    const list = await (await get("/admin/broadcasts", cookie)).text();
    expect(list).toContain("%name%さんへ");
    const audit = await env.ctx.db.query<{ action: string }>("SELECT action FROM admin_audit ORDER BY id");
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["broadcast.create", "broadcast.test", "broadcast.schedule"]));
  });
});

describe("admin readers, forms, sequences, settings", () => {
  it("shows readers and manages tags", async () => {
    const cookie = await loginCookie();
    await importContacts(env.ctx.db, "email,name\nr@example.com,読者A\n", { label: "old", evidence: "test" });
    const list = await (await get("/admin/readers?q=r@example", cookie)).text();
    expect(list).toContain("r@example.com");
    const [c] = await env.ctx.db.query<{ id: string }>("SELECT id FROM contacts");
    await post(`/admin/readers/${c!.id}/tags`, { tag: "int:ライティング" }, cookie);
    const detail = await (await get(`/admin/readers/${c!.id}`, cookie)).text();
    expect(detail).toContain("int:ライティング");
    expect(detail).toContain("同意の記録");
  });

  it("creates a form, updates its pages and shows the embed tag", async () => {
    const cookie = await loginCookie();
    const res = await post("/admin/forms", { name: "特典A", slug: "gift-a" }, cookie);
    const id = /\/admin\/forms\/([0-9a-f-]+)/.exec(res.headers.get("location") ?? "")![1]!;
    const save = await post(
      `/admin/forms/${id}`,
      {
        name: "特典A", active: "1", tag: "src:gift-a", consent_text_version: "v1", button_label: "受け取る",
        allowed_origins: "https://blog.example.com", confirm_subject: "確認", confirm_body: "[完了する](%confirm%)", confirm_format: "markdown",
        sent_url: "http://insecure.example.com",
      },
      cookie,
    );
    expect(decodeURIComponent(save.headers.get("location") ?? "")).toContain("https://");
    await post(
      `/admin/forms/${id}`,
      { name: "特典A", active: "1", tag: "src:gift-a", consent_text_version: "v1", button_label: "受け取る", allowed_origins: "https://blog.example.com", confirm_subject: "確認", confirm_body: "[完了する](%confirm%)", confirm_format: "markdown" },
      cookie,
    );
    const page = await (await get(`/admin/forms/${id}`, cookie)).text();
    expect(page).toContain("tsuzuri-form");
    expect(page).toContain("受け取る");
    const [f] = await env.ctx.db.query<{ active: boolean; allowed_origins: string[] }>("SELECT active, allowed_origins FROM forms");
    expect(f).toEqual({ active: true, allowed_origins: ["https://blog.example.com"] });
  });

  it("edits the form's fields as a table and keeps the tab after saving", async () => {
    const cookie = await loginCookie();
    const res = await post("/admin/forms", { name: "特典B", slug: "gift-b" }, cookie);
    const id = /\/admin\/forms\/([0-9a-f-]+)/.exec(res.headers.get("location") ?? "")![1]!;
    const base = { name: "特典B", active: "1", consent_text_version: "v1", button_label: "登録", confirm_subject: "確認", confirm_body: "[完了](%confirm%)", confirm_format: "markdown", tab: "fields", fields_present: "1" };
    const bad = await post(`/admin/forms/${id}`, { ...base, fk: ["name", ""], fl: ["お名前", "興味"], ft: ["text", "radio"], fr: ["0", "0"], fe: ["1", "1"], fx: ["", ""] }, cookie);
    expect(decodeURIComponent(bad.headers.get("location") ?? "")).toContain("選択肢を入れてください");
    const ok = await post(
      `/admin/forms/${id}`,
      { ...base, fk: ["", "name"], fl: ["興味", "ニックネーム"], ft: ["checkbox", "text"], fr: ["0", "1"], fe: ["1", "1"], fx: ["SNS, AI", ""], accept_until: "2099-01-01T09:00" },
      cookie,
    );
    expect(ok.headers.get("location")).toContain(`/admin/forms/${id}?tab=fields`);
    const [f] = await env.ctx.db.query<{ fields: { key: string; label: string; required: boolean; options: string[] }[]; accept_until: Date }>(
      "SELECT fields, accept_until FROM forms WHERE id = $1",
      [id],
    );
    expect(f!.fields.map((x) => [x.key, x.label, x.required, x.options])).toEqual([
      ["free1", "興味", false, ["SNS", "AI"]],
      ["name", "ニックネーム", true, []],
    ]);
    expect(new Date(f!.accept_until).toISOString()).toBe("2099-01-01T00:00:00.000Z");
    const page = await (await get(`/admin/forms/${id}?tab=fields`, cookie)).text();
    expect(page).toContain('data-tab="fields" aria-current="page"');
    expect(page).toContain("%attr.free1%");
  });

  it("creates a sequence and adds conditional steps", async () => {
    const cookie = await loginCookie();
    const res = await post("/admin/sequences", { name: "特典A", slug: "gift-a" }, cookie);
    const id = /\/admin\/sequences\/([0-9a-f-]+)/.exec(res.headers.get("location") ?? "")![1]!;
    await post(`/admin/sequences/${id}/steps`, { delay_days: "0", subject: "1通目", body: "本文", format: "markdown" }, cookie);
    await post(`/admin/sequences/${id}/steps`, { delay_days: "2", send_time: "08:00", subject: "2通目", body: "本文", format: "html", minScore: "60", tiers: ["hot"] }, cookie);
    const steps = await env.ctx.db.query<{ position: number; condition: unknown; body_format: string }>(
      "SELECT position, condition, body_format FROM sequence_steps ORDER BY position",
    );
    expect(steps).toEqual([
      { position: 1, condition: null, body_format: "markdown" },
      { position: 2, condition: { minScore: 60, tiers: ["hot"] }, body_format: "html" },
    ]);
    const page = await (await get(`/admin/sequences/${id}`, cookie)).text();
    expect(page).toContain("スコア 60 以上");
  });

  it("saves settings without dropping other values and validates score tiers", async () => {
    const cookie = await loginCookie();
    await env.ctx.db.query("INSERT INTO app_settings (id, settings) VALUES (1, $1)", [JSON.stringify({ footerExtraLines: ["残す行"] })]);
    await post("/admin/settings", { fromAddress: "info@ml.example.com", fromName: "つづり", senderName: "つづり", contact: "https://example.com/c", defaultName: "読者", testRecipients: "a@example.com, not-an-email" }, cookie);
    const [s] = await env.ctx.db.query<{ settings: Record<string, unknown> }>("SELECT settings FROM app_settings");
    expect(s!.settings.footerExtraLines).toEqual(["残す行"]);
    expect(s!.settings.testRecipients).toEqual(["a@example.com"]);
    const bad = await post("/admin/settings/score", { t_hot: "10", t_normal: "40", t_low: "20" }, cookie);
    expect(decodeURIComponent(bad.headers.get("location") ?? "")).toContain("熱心 > 通常 > 低下");
  });
});

describe("admin topics", () => {
  it("creates a topic and assigns it to a broadcast", async () => {
    const cookie = await loginCookie();
    await post("/admin/topics", { name: "メルマガ本誌", slug: "newsletter", position: "1", default_subscribed: "1", visible: "1" }, cookie);
    const [t] = await env.ctx.db.query<{ id: string; default_subscribed: boolean }>("SELECT id, default_subscribed FROM topics");
    expect(t!.default_subscribed).toBe(true);
    const page = await (await get("/admin/topics", cookie)).text();
    expect(page).toContain("メルマガ本誌");

    const res = await post("/admin/broadcasts", { subject: "号", body: "本文", format: "markdown", topic_id: t!.id }, cookie);
    expect(res.status).toBe(303);
    const [b] = await env.ctx.db.query<{ topic_id: string }>("SELECT topic_id FROM broadcasts");
    expect(b!.topic_id).toBe(t!.id);
    // 存在しない種類は無視される
    await post("/admin/broadcasts", { subject: "号2", body: "本文", format: "markdown", topic_id: "00000000-0000-0000-0000-000000000000" }, cookie);
    const rows = await env.ctx.db.query<{ topic_id: string | null }>("SELECT topic_id FROM broadcasts WHERE subject = '号2'");
    expect(rows[0]!.topic_id).toBeNull();
  });
});

describe("sending domains and per-scenario sender", () => {
  it("registers a domain, shows the DNS records and lets a scenario send from it", async () => {
    const cookie = await loginCookie();
    env.ctx.settings.testRecipients = ["owner@example.com"];
    env.ctx.identityStatus = async (d) =>
      d === "news.other.jp"
        ? { found: true, verified: false, dkimStatus: "PENDING", dkimTokens: ["tok1", "tok2", "tok3"], mailFromStatus: "PENDING" }
        : { found: true, verified: true, dkimStatus: "SUCCESS", dkimTokens: ["a", "b", "c"], mailFromStatus: "SUCCESS" };

    const seqRes = await post("/admin/sequences", { name: "別ブランド", slug: "brand-b" }, cookie);
    const seqId = /\/admin\/sequences\/([0-9a-f-]+)/.exec(seqRes.headers.get("location") ?? "")![1]!;
    const settings = { name: "別ブランド", status: "draft", from_name: "ブランドB", from_address: "hello@news.other.jp", reply_to: "" };

    // まだ登録していないドメインは使えない
    const denied = await post(`/admin/sequences/${seqId}`, settings, cookie);
    expect(decodeURIComponent(denied.headers.get("location") ?? "")).toContain("登録されていません");

    await post("/admin/domains", { domain: "https://News.Other.jp/" }, cookie);
    expect(env.ctx.settings.sendingDomains).toEqual(["news.other.jp"]);
    const page = await (await get("/admin/domains", cookie)).text();
    expect(page).toContain("tok1._domainkey.news.other.jp");
    expect(page).toContain("bounce.news.other.jp");
    expect(page).toContain("まだ送信できません");

    const ok = await post(`/admin/sequences/${seqId}`, settings, cookie);
    expect(decodeURIComponent(ok.headers.get("location") ?? "")).toContain("ok=");

    // テスト送信はシナリオの送信者で届く
    await post(`/admin/sequences/${seqId}/steps`, { delay_days: "0", subject: "1通目", body: "本文", format: "markdown" }, cookie);
    const [st] = await env.ctx.db.query<{ id: string }>("SELECT id FROM sequence_steps WHERE sequence_id = $1", [seqId]);
    await post(`/admin/sequences/${seqId}/steps/${st!.id}/test`, {}, cookie);
    const sent = env.provider.sent.at(-1)!;
    expect(sent.from).toEqual({ address: "hello@news.other.jp", name: "ブランドB" });

    // 使っている間は外せない
    const rm = await post("/admin/domains/remove", { domain: "news.other.jp" }, cookie);
    expect(decodeURIComponent(rm.headers.get("location") ?? "")).toContain("外せません");
  });
});

describe("scenario page", () => {
  it("starts and stops a scenario from the status bar, only once it has a step", async () => {
    const cookie = await loginCookie();
    const res = await post("/admin/sequences", { name: "講座", slug: "course" }, cookie);
    const id = /\/admin\/sequences\/([0-9a-f-]+)/.exec(res.headers.get("location") ?? "")![1]!;
    const early = await post(`/admin/sequences/${id}/status`, { status: "active" }, cookie);
    expect(decodeURIComponent(early.headers.get("location") ?? "")).toContain("先に 1 通目");
    await post(`/admin/sequences/${id}/steps`, { timing: "now", subject: "1通目", body: "本文", format: "markdown" }, cookie);
    await post(`/admin/sequences/${id}/status`, { status: "active" }, cookie);
    const page = await (await get(`/admin/sequences/${id}`, cookie)).text();
    expect(page).toContain("配信を止める");
    expect(page).toContain('data-tab="steps" aria-current="page"');
    const [s] = await env.ctx.db.query<{ status: string }>("SELECT status FROM sequences WHERE id = $1", [id]);
    expect(s!.status).toBe("active");
  });

  it("collapses the DNS guide once a domain is verified", async () => {
    const cookie = await loginCookie();
    env.ctx.identityStatus = async () => ({ found: true, verified: true, dkimStatus: "SUCCESS", dkimTokens: ["a", "b", "c"], mailFromStatus: "SUCCESS" });
    const page = await (await get("/admin/domains", cookie)).text();
    expect(page).toContain('<details class="dns-box"><summary>');
    env.ctx.identityStatus = async () => ({ found: true, verified: false, dkimStatus: "PENDING", dkimTokens: ["a", "b", "c"], mailFromStatus: "PENDING" });
    expect(await (await get("/admin/domains", cookie)).text()).toContain('<details class="dns-box" open>');
  });
});

describe("opt-in mode", () => {
  it("creates new scenario forms as single opt-in and keeps admin invites on double opt-in", async () => {
    const cookie = await loginCookie();
    await post("/admin/sequences", { name: "新講座", slug: "new-course" }, cookie);
    const [f] = await env.ctx.db.query<{ id: string; double_optin: boolean }>("SELECT id, double_optin FROM forms WHERE slug = 'new-course'");
    expect(f!.double_optin).toBe(false);
    const page = await (await get(`/admin/forms/${f!.id}`, cookie)).text();
    expect(page).toContain('name="double_optin" value="0" checked');
    // 管理画面からの招待は、シングルオプトインのフォームでも確認メールを送る
    const r = await post("/admin/readers/new", { mode: "invite", form_id: f!.id, email: "friend@example.com" }, cookie);
    expect(decodeURIComponent(r.headers.get("location") ?? "")).toContain("確認メールの送信を受け付けました");
    const [c] = await env.ctx.db.query<{ status: string }>("SELECT status FROM contacts");
    expect(c!.status).toBe("pending");
  });
});

describe("tag names without the src: prefix", () => {
  it("renames existing src: tags and the places that refer to them by name", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { MIGRATIONS_DIR } = await import("../src/db.js");
    const db = env.ctx.db;
    await db.query("INSERT INTO tags (name, category) VALUES ('src:seminar', 'src'), ('src:dup', 'src'), ('dup', 'cust')");
    await db.query("INSERT INTO automation_rules (name, trigger_type, trigger_value, action_type, action_value) VALUES ('r', 'tag_added', 'src:seminar', 'add_tag', 'src:seminar')");
    await db.query(`INSERT INTO broadcasts (subject, body_markdown, segment_definition, status) VALUES ('s', 'b', '{"type":"tag","tag":"src:seminar","has":true}', 'draft')`);
    const sql = readFileSync(join(MIGRATIONS_DIR, "0012_tag_names_without_prefix.sql"), "utf8").replace(/--.*$/gm, "");
    for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.query(stmt);
    const names = (await db.query<{ name: string }>("SELECT name FROM tags ORDER BY name")).map((t) => t.name);
    expect(names).toContain("seminar");
    expect(names).toContain("src:dup"); // 同じ名前があるものは残す
    const [r] = await db.query<{ trigger_value: string; action_value: string }>("SELECT trigger_value, action_value FROM automation_rules");
    expect(r).toEqual({ trigger_value: "seminar", action_value: "seminar" });
    const [b] = await db.query<{ segment_definition: { tag: string } }>("SELECT segment_definition FROM broadcasts");
    expect(b!.segment_definition.tag).toBe("seminar");
  });
});

describe("delivery log paging", () => {
  it("shows the chosen number of rows and links to the next page", async () => {
    const cookie = await loginCookie();
    await importContacts(env.ctx.db, "email\n" + Array.from({ length: 30 }, (_, i) => `u${i}@example.com`).join("\n") + "\n", { label: "bulk", evidence: "test" });
    await env.ctx.db.query(
      `INSERT INTO messages (idempotency_key, contact_id, channel_id, provider, kind, status)
       SELECT 'k' || ch.id, ch.contact_id, ch.id, 'memory', 'broadcast', 'sent' FROM channels ch`,
    );
    const page = await (await get("/admin/logs?per=25", cookie)).text();
    expect(page).toContain("全 30 件中 1–25 件");
    expect(page).toMatch(/href="\/admin\/logs\?per=25(&amp;|&)page=2"/);
    const p2 = await (await get("/admin/logs?per=25&page=2", cookie)).text();
    expect(p2).toContain("全 30 件中 26–30 件");
  });
});

describe("signup routes and scenario analytics", () => {
  it("lists routes with counts and shows the scenario analytics", async () => {
    const cookie = await loginCookie();
    await post("/admin/routes", { name: "X プロフィール", code: "x-profile" }, cookie);
    const res = await post("/admin/sequences", { name: "分析テスト", slug: "an-test" }, cookie);
    const seqId = /\/admin\/sequences\/([0-9a-f-]+)/.exec(res.headers.get("location") ?? "")![1]!;
    await post(`/admin/sequences/${seqId}/steps`, { timing: "now", subject: "1通目", body: "本文", format: "markdown" }, cookie);
    await post(`/admin/sequences/${seqId}/steps`, { timing: "days", delay_days: "1", send_time: "08:00", subject: "2通目", body: "本文", format: "markdown" }, cookie);
    const [form] = await env.ctx.db.query<{ id: string }>("SELECT id FROM forms WHERE slug = 'an-test'");
    const steps = await env.ctx.db.query<{ id: string }>("SELECT id FROM sequence_steps WHERE sequence_id = $1 ORDER BY position", [seqId]);
    // 10 人が経路 x-profile から入り、1 通目を受け取る。2 人がクリック、1 人が配信停止
    await importContacts(env.ctx.db, "email\n" + Array.from({ length: 10 }, (_, i) => `r${i}@example.com`).join("\n") + "\n", { label: "an", evidence: "test" });
    const now = env.ctx.now();
    await env.ctx.db.query(
      `INSERT INTO consents (channel_id, method, form_id, consent_text_version, consented_at, confirmed_at, route_id)
       SELECT ch.id, 'form', $1, 'v1', $2, $2, (SELECT id FROM signup_routes WHERE code = 'x-profile') FROM channels ch WHERE ch.address LIKE 'r%'`,
      [form!.id, now],
    );
    await env.ctx.db.query("INSERT INTO enrollments (contact_id, sequence_id, enrolled_at) SELECT contact_id, $1, $2 FROM channels WHERE address LIKE 'r%'", [seqId, now]);
    await env.ctx.db.query(
      `INSERT INTO messages (idempotency_key, contact_id, channel_id, provider, kind, status, step_id, sent_at)
       SELECT 's1' || ch.id, ch.contact_id, ch.id, 'memory', 'sequence', 'delivered', $1, $2 FROM channels ch WHERE ch.address LIKE 'r%'`,
      [steps[0]!.id, now],
    );
    await env.ctx.db.query(
      `INSERT INTO events (contact_id, message_id, type, occurred_at)
       SELECT m.contact_id, m.id, 'click', $1 FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE ch.address IN ('r0@example.com', 'r1@example.com')`,
      [now],
    );
    await env.ctx.db.query(
      "INSERT INTO events (contact_id, type, occurred_at) SELECT contact_id, 'unsubscribe', $1 FROM channels WHERE address = 'r9@example.com'",
      [new Date(now.getTime() + 3_600_000)],
    );

    const routes = await (await get("/admin/routes?days=0", cookie)).text();
    expect(routes).toContain("X プロフィール");
    expect(routes).toMatch(/<span>10<\/span>/);

    const page = await (await get(`/admin/sequences/${seqId}?tab=analytics&days=0`, cookie)).text();
    expect(page).toContain('data-tab="analytics" aria-current="page"');
    expect(page).toContain("20.0%"); // 1 通目のクリック率
    expect(page).toContain("10.0%（1 人）"); // 1 通目のあとの配信停止
    expect(page).toContain("配信停止が多い（1% 以上）");
    expect(page).toContain("登録経路別");
  });
});

describe("admin groups", () => {
  const sectionOrder = (html: string) => [...html.matchAll(/class="group-head">.*?<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  const rowOrder = (html: string) => [...html.matchAll(/<tr data-id="([^"]+)">/g)].map((m) => m[1]);

  it("groups scenarios, saves drag-and-drop order and keeps them when a group is deleted", async () => {
    const cookie = await loginCookie();
    // グループが無いうちは表 1 つ。作成は右上のボタンから開く小窓
    await post("/admin/sequences", { name: "ゆとりメルマガ", slug: "yutori" }, cookie);
    let page = await (await get("/admin/sequences", cookie)).text();
    expect(page).not.toContain('class="group-card"');
    expect(page).toContain('<dialog class="modal" id="new-seq"');
    expect(page).toContain('data-dialog="new-seq"');

    // 作るとそのグループの位置へ飛ぶ
    const created = await post("/admin/groups", { kind: "sequence", name: "商品受け渡し" }, cookie);
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toMatch(/^\/admin\/sequences\?ok=.+#g-[0-9a-f-]+$/);
    await post("/admin/groups", { kind: "sequence", name: "ステップ" }, cookie);
    const dup = await post("/admin/groups", { kind: "sequence", name: "ステップ" }, cookie);
    expect(decodeURIComponent(dup.headers.get("location") ?? "")).toContain("同じ名前のグループがあります");
    // 同じ名前でも種類が違えば作れる
    await post("/admin/groups", { kind: "form", name: "ステップ" }, cookie);

    const groups = await env.ctx.db.query<{ id: string; name: string; kind: string }>("SELECT id, name, kind FROM item_groups ORDER BY position");
    const gift = groups.find((g) => g.kind === "sequence" && g.name === "商品受け渡し")!;
    const step = groups.find((g) => g.kind === "sequence" && g.name === "ステップ")!;
    const formGroup = groups.find((g) => g.kind === "form")!;

    // 作るときにグループを選べる
    await post("/admin/sequences", { name: "分析シート", slug: "sheet", group_id: gift.id }, cookie);
    page = await (await get("/admin/sequences", cookie)).text();
    expect(page).toContain(`id="g-${gift.id}"`);
    expect(sectionOrder(page)).toEqual(["グループなし", "商品受け渡し", "ステップ"]);

    // ドラッグ後の並びを保存：グループの順、項目の順と所属
    const seq = Object.fromEntries((await env.ctx.db.query<{ id: string; slug: string }>("SELECT id, slug FROM sequences")).map((r) => [r.slug, r.id]));
    const order = (groupsOrder: string[], items: string[]) => post("/admin/groups/order", { kind: "sequence", groups: groupsOrder, items }, cookie);
    expect((await order([step.id, gift.id], [`${seq.sheet}:${gift.id}`, `${seq.yutori}:${gift.id}`])).status).toBe(200);
    page = await (await get("/admin/sequences", cookie)).text();
    expect(sectionOrder(page)).toEqual(["グループなし", "ステップ", "商品受け渡し"]);
    expect(rowOrder(page)).toEqual([seq.sheet, seq.yutori]);
    // 知らない id や別の種類のグループは受け付けず、何も変えない
    expect((await order([formGroup.id], [])).status).toBe(400);
    expect((await order([], [`${seq.sheet}:${formGroup.id}`])).status).toBe(400);
    expect(rowOrder(await (await get("/admin/sequences", cookie)).text())).toEqual([seq.sheet, seq.yutori]);

    await post(`/admin/groups/${gift.id}/rename`, { name: "【商品受け渡し】" }, cookie);
    expect(sectionOrder(await (await get("/admin/sequences", cookie)).text())).toEqual(["グループなし", "ステップ", "【商品受け渡し】"]);

    // グループを消しても、シナリオは消えずグループなしに戻る
    await post(`/admin/groups/${gift.id}/delete`, {}, cookie);
    const left = await env.ctx.db.query<{ group_id: string | null }>("SELECT group_id FROM sequences");
    expect(left).toHaveLength(2);
    expect(left.every((r) => r.group_id === null)).toBe(true);
  });

  it("groups forms and keeps the newsletter-only form at the bottom", async () => {
    const cookie = await loginCookie();
    await post("/admin/groups", { kind: "form", name: "特典" }, cookie);
    const [g] = await env.ctx.db.query<{ id: string }>("SELECT id FROM item_groups");
    await post("/admin/forms", { name: "特典A", slug: "gift-a", group_id: g!.id }, cookie);
    await post("/admin/forms", { name: "メルマガ", slug: "news" }, cookie);
    const page = await (await get("/admin/forms", cookie)).text();
    expect(sectionOrder(page)).toEqual(["グループなし", "特典"]);
    expect(page).toContain('data-kind="form"');
    expect(page.indexOf('id="grouped"')).toBeLessThan(page.indexOf("メルマガだけのフォームを作る"));
  });
});

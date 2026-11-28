import { base32Decode, generateTotpSecret, hashPassword, totp } from "@tsuzuri/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { sendMessage } from "../src/services/sending.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { subscribe } from "../src/services/subscription.js";
import { linkStats, mailStats, recipients } from "../src/services/reports.js";
import { renameTagInCondition } from "../src/services/tags.js";
import { renameTagInSegment } from "../src/segments.js";
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

function post(path: string, data: Record<string, string | string[]>, cookie: string) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return app.request(`https://mail.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", cookie },
    body: body.toString(),
  });
}
const get = (path: string, cookie: string) => app.request(`https://mail.example.com${path}`, { headers: { cookie } });
async function loginCookie(): Promise<string> {
  const res = await post("/admin/login", { password: PASSWORD, code: totp(base32Decode(totpSecret), env.ctx.now()) }, "");
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const idFrom = (res: Response, kind: string) => new RegExp(`/admin/${kind}/([0-9a-f-]+)`).exec(res.headers.get("location") ?? "")![1]!;
const tagId = async (name: string) => (await env.ctx.db.query<{ id: string }>("SELECT id FROM tags WHERE name = $1", [name]))[0]?.id;

/** シナリオ（1 通）とフォームを作り、読者を 1 人登録して 1 通目を送る */
async function scenarioWithOneSent(cookie: string) {
  const res = await post("/admin/sequences", { name: "特典シナリオ", slug: "gift" }, cookie);
  const seqId = idFrom(res, "sequences");
  await post(`/admin/sequences/${seqId}/steps`, { timing: "now", subject: "ようこそ", body: "[記事](https://example.com/a) [別](https://example.com/b)", format: "markdown" }, cookie);
  await post(`/admin/sequences/${seqId}/status`, { status: "active" }, cookie);
  const sub = await subscribe(env.ctx, { formSlug: "gift", email: "reader@example.com" }, { allowInactiveForm: true });
  expect(sub.status).toBe("subscribed");
  const ids = await scheduleDueSteps(env.ctx);
  expect(ids).toHaveLength(1);
  expect(await sendMessage(env.ctx, ids[0]!)).toBe("sent");
  const [step] = await env.ctx.db.query<{ id: string }>("SELECT id FROM sequence_steps WHERE sequence_id = $1", [seqId]);
  return { seqId, stepId: step!.id, messageId: ids[0]! };
}

describe("tag renames inside JSON", () => {
  it("renames tags only where they are tags", () => {
    expect(renameTagInCondition({ hasTags: ["a", "hot"], lacksTags: ["b"], tiers: ["hot"] }, "hot", "熱い")).toEqual({ hasTags: ["a", "熱い"], lacksTags: ["b"], tiers: ["hot"] });
    expect(
      renameTagInSegment({ type: "group", op: "and", rules: [{ type: "tag", tag: "hot", has: true }, { type: "tier", in: ["hot"] }] }, "hot", "熱い"),
    ).toEqual({ type: "group", op: "and", rules: [{ type: "tag", tag: "熱い", has: true }, { type: "tier", in: ["hot"] }] });
  });
});

describe("tag management", () => {
  it("renames, merges and deletes tags that forms and scenarios created", async () => {
    const cookie = await loginCookie();
    const { seqId } = await scenarioWithOneSent(cookie);
    const auto = (await tagId("特典シナリオ"))!;
    expect(auto).toBeTruthy();
    // ルールと条件が名前で使っている
    await env.ctx.db.query("INSERT INTO automation_rules (name, trigger_type, trigger_value, action_type, action_value) VALUES ('r', 'tag_added', '特典シナリオ', 'add_tag', '特典シナリオ')");
    await env.ctx.db.query(`UPDATE sequence_steps SET condition = '{"hasTags":["特典シナリオ"]}' WHERE sequence_id = $1`, [seqId]);

    expect((await post(`/admin/tags/${auto}/rename`, { name: "特典A" }, cookie)).status).toBe(303);
    const [rule] = await env.ctx.db.query<{ trigger_value: string; action_value: string }>("SELECT trigger_value, action_value FROM automation_rules");
    expect(rule).toEqual({ trigger_value: "特典A", action_value: "特典A" });
    const [step] = await env.ctx.db.query<{ condition: { hasTags: string[] } }>("SELECT condition FROM sequence_steps WHERE sequence_id = $1", [seqId]);
    expect(step!.condition.hasTags).toEqual(["特典A"]);

    // 名前で使っている間は消せない
    const blocked = await post(`/admin/tags/${auto}/delete`, {}, cookie);
    expect(decodeURIComponent(blocked.headers.get("location") ?? "")).toContain("削除できません");
    expect(await tagId("特典A")).toBe(auto);

    // 別のタグに統合すると、読者・フォーム・ルール・条件が付け替わり、元のタグは消える
    await post("/admin/tags", { name: "メルマガ" }, cookie);
    const into = (await tagId("メルマガ"))!;
    await post(`/admin/tags/${auto}/merge`, { into }, cookie);
    expect(await tagId("特典A")).toBeUndefined();
    const [form] = await env.ctx.db.query<{ tag_id: string }>("SELECT tag_id FROM forms WHERE slug = 'gift'");
    expect(form!.tag_id).toBe(into);
    const [tagged] = await env.ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM contact_tags WHERE tag_id = $1", [into]);
    expect(tagged!.n).toBe(1);
    const [rule2] = await env.ctx.db.query<{ trigger_value: string }>("SELECT trigger_value FROM automation_rules");
    expect(rule2!.trigger_value).toBe("メルマガ");

    // ルールと条件を外せば消せる。フォームからは外れ、フォームは残る
    await env.ctx.db.query("DELETE FROM automation_rules");
    await env.ctx.db.query("UPDATE sequence_steps SET condition = NULL");
    await post(`/admin/tags/${into}/delete`, {}, cookie);
    expect(await tagId("メルマガ")).toBeUndefined();
    const [form2] = await env.ctx.db.query<{ tag_id: string | null }>("SELECT tag_id FROM forms WHERE slug = 'gift'");
    expect(form2!.tag_id).toBeNull();
    const page = await (await get("/admin/tags", cookie)).text();
    expect(page).toContain("新しいタグ");
  });

  it("lets a new scenario use an existing tag instead of creating one", async () => {
    const cookie = await loginCookie();
    await post("/admin/tags", { name: "共通タグ" }, cookie);
    await post("/admin/sequences", { name: "別シナリオ", slug: "other", tag_choice: (await tagId("共通タグ"))! }, cookie);
    expect(await tagId("別シナリオ")).toBeUndefined();
    const [form] = await env.ctx.db.query<{ tag_id: string }>("SELECT tag_id FROM forms WHERE slug = 'other'");
    expect(form!.tag_id).toBe(await tagId("共通タグ"));
  });
});

describe("deleting forms and scenarios", () => {
  it("deletes a scenario, keeps the send history and consents, and optionally its form", async () => {
    const cookie = await loginCookie();
    const { seqId, messageId } = await scenarioWithOneSent(cookie);
    await env.ctx.db.query("INSERT INTO automation_rules (name, trigger_type, trigger_value, action_type, action_value) VALUES ('next', 'sequence_completed', $1, 'add_tag', 'x')", [seqId]);
    const page = await (await get(`/admin/sequences/${seqId}?tab=settings`, cookie)).text();
    expect(page).toContain("このシナリオを削除");

    await post(`/admin/sequences/${seqId}/delete`, { with_forms: "1" }, cookie);
    expect(await env.ctx.db.query("SELECT 1 FROM sequences WHERE id = $1", [seqId])).toHaveLength(0);
    expect(await env.ctx.db.query("SELECT 1 FROM forms WHERE slug = 'gift'")).toHaveLength(0);
    expect(await env.ctx.db.query("SELECT 1 FROM automation_rules")).toHaveLength(0);
    const [m] = await env.ctx.db.query<{ subject: string; step_id: string | null }>("SELECT subject, step_id FROM messages WHERE id = $1", [messageId]);
    expect(m).toEqual({ subject: "ようこそ", step_id: null });
    const [co] = await env.ctx.db.query<{ form_id: string | null; evidence: { deleted_form?: { slug: string } } }>("SELECT form_id, evidence FROM consents");
    expect(co!.form_id).toBeNull();
    expect(co!.evidence.deleted_form?.slug).toBe("gift");
    // 配信ログには「削除したシナリオ」として残る
    const logs = await (await get("/admin/logs", cookie)).text();
    expect(logs).toContain("削除したシナリオ");
    expect(logs).toContain("ようこそ");
  });

  it("deletes a form but keeps the scenario", async () => {
    const cookie = await loginCookie();
    const { seqId } = await scenarioWithOneSent(cookie);
    const [form] = await env.ctx.db.query<{ id: string }>("SELECT id FROM forms WHERE slug = 'gift'");
    const res = await post(`/admin/forms/${form!.id}/delete`, {}, cookie);
    expect(res.headers.get("location")).toContain("/admin/forms");
    expect(await env.ctx.db.query("SELECT 1 FROM forms")).toHaveLength(0);
    expect(await env.ctx.db.query("SELECT 1 FROM sequences WHERE id = $1", [seqId])).toHaveLength(1);
    expect(await env.ctx.db.query("SELECT 1 FROM consents")).toHaveLength(1);
  });
});

describe("per-mail reports", () => {
  it("counts opens, clicks per link and lists who clicked", async () => {
    const cookie = await loginCookie();
    const { stepId, messageId } = await scenarioWithOneSent(cookie);
    const [m] = await env.ctx.db.query<{ contact_id: string }>("SELECT contact_id FROM messages WHERE id = $1", [messageId]);
    const ev = (type: string, data: object, bot: string | null = null) =>
      env.ctx.db.query("INSERT INTO events (contact_id, message_id, type, data, bot_reason) VALUES ($1, $2, $3, $4, $5)", [m!.contact_id, messageId, type, JSON.stringify(data), bot]);
    await ev("open", {});
    await ev("click", { index: 0, url: "https://example.com/a" });
    await ev("click", { index: 0, url: "https://example.com/a" });
    await ev("click", { index: 1, url: "https://example.com/b" }, "too-fast");

    const st = await mailStats(env.ctx, "step", stepId);
    expect(st).toMatchObject({ sent: 1, opened: 1, clicked: 1 });
    const links = await linkStats(env.ctx, "step", stepId);
    expect(links).toEqual([
      { url: "https://example.com/a", index: 0, clickers: 1, clicks: 2 },
      { url: "https://example.com/b", index: 1, clickers: 0, clicks: 0 },
    ]);
    expect((await recipients(env.ctx, "step", stepId, { filter: "clicked", url: "https://example.com/b", limit: 10, offset: 0 })).total).toBe(0);
    expect((await recipients(env.ctx, "step", stepId, { filter: "clicked", url: "https://example.com/a", limit: 10, offset: 0 })).total).toBe(1);

    const page = await (await get(`/admin/logs/mail/step/${stepId}`, cookie)).text();
    expect(page).toContain("リンクごとのクリック");
    expect(page).toContain("https://example.com/a");
    expect(page).toContain("reader@example.com");
    const list = await (await get("/admin/logs?type=step", cookie)).text();
    expect(list).toContain(`/admin/logs/mail/step/${stepId}`);
  });
});

describe("HTML bodies with percent signs", () => {
  it("saves an HTML step whose URLs and CSS contain %", async () => {
    const cookie = await loginCookie();
    const res = await post("/admin/sequences", { name: "HTML", slug: "html-seq" }, cookie);
    const seqId = idFrom(res, "sequences");
    const body = '<div style="width:100%"><a href="https://example.com/?q=%E3%81%82%E3%81%84">検索</a> %name%さん</div>';
    const r = await post(`/admin/sequences/${seqId}/steps`, { timing: "now", subject: "件名", body, format: "html" }, cookie);
    expect(decodeURIComponent(r.headers.get("location") ?? "")).toContain("ステップを追加しました");
    // Markdown のままなら、知らない置き換え文字として止める（打ち間違いの検出は残す）
    const r2 = await post(`/admin/sequences/${seqId}/steps`, { timing: "now", subject: "件名", body: "%cancell%", format: "markdown" }, cookie);
    expect(decodeURIComponent(r2.headers.get("location") ?? "")).toContain("cancell");
  });
});

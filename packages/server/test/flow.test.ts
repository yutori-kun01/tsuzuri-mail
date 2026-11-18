import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { countRecipients, launchDueBroadcasts } from "../src/services/broadcasts.js";
import { syncContent } from "../src/services/content.js";
import { importContacts, parseCsv } from "../src/services/import.js";
import { recomputeAllScores } from "../src/services/scoring.js";
import { sendMessage } from "../src/services/sending.js";
import { handleSesEvent } from "../src/services/ses-events.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { confirm, subscribe, unsubscribe } from "../src/services/subscription.js";
import { recordClick, recordDownload } from "../src/services/tracking.js";
import { nextSendAt } from "../src/time.js";
import { createEnv, type TestEnv } from "./helpers.js";

const HUMAN = { method: "GET", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" };

async function writeContent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsuzuri-content-"));
  await mkdir(join(root, "forms"), { recursive: true });
  await mkdir(join(root, "sequences", "seo"), { recursive: true });
  await mkdir(join(root, "sequences", "reengage"), { recursive: true });
  await writeFile(join(root, "variables.json"), JSON.stringify([{ key: "lp_url", value: "https://example.com/lp", kind: "url" }]));
  await writeFile(
    join(root, "forms", "seo-checklist.md"),
    `---\nname: SEOチェックリスト\nsequence: seo\nlead_magnet: magnets/seo.pdf\n---\n%name|%こんにちは。\n\n[登録を完了する](%confirm%)`,
  );
  await writeFile(join(root, "sequences", "seo", "_sequence.md"), "---\nname: SEO特典\nstatus: active\ndone_tag: seq:seo:done\n---\n");
  await writeFile(
    join(root, "sequences", "seo", "01_deliver.md"),
    "---\nsubject: %name%さん、特典をお届けします\ndelay_days: 0\n---\n[特典をダウンロード](%特典%)\n\n[解説記事](%lp_url%)\n\n[配信解除](%cancel%)",
  );
  await writeFile(join(root, "sequences", "seo", "02_tips.md"), "---\nsubject: 2通目\ndelay_days: 2\n---\n続きです。[記事](https://example.org/2)");
  await writeFile(join(root, "sequences", "reengage", "_sequence.md"), "---\nname: 再確認\nstatus: active\npurpose: reengage\n---\n");
  await writeFile(
    join(root, "sequences", "reengage", "01_ask.md"),
    "---\nsubject: このまま受け取りますか？\n---\n[受け取り続ける](https://example.com/keep)",
  );
  return root;
}

const extract = (html: string, path: string) => new RegExp(`https://mail\\.example\\.com/${path}/([^"<\\s]+)`).exec(html)?.[1];

let env: TestEnv;
beforeEach(async () => {
  env = await createEnv();
  const report = await syncContent(env.ctx.db, await writeContent());
  expect(report.problems).toEqual([]);
});

describe("signup → confirm → sequence", () => {
  it("runs the whole double opt-in and step delivery flow", async () => {
    const { ctx, provider } = env;
    const sub = await subscribe(ctx, { formSlug: "seo-checklist", email: " Reader@Example.com ", name: "山田" });
    expect(sub.status).toBe("confirmation-sent");
    if (sub.status !== "confirmation-sent") return;

    // 確認メール（計測なし、配信停止ヘッダーなし）
    expect(await sendMessage(ctx, sub.messageId)).toBe("sent");
    const optin = provider.sent[0]!;
    expect(optin.to).toBe("reader@example.com");
    expect(optin.html).toContain("山田こんにちは");
    expect(optin.headers["List-Unsubscribe"]).toBeUndefined();
    const confirmToken = extract(optin.html, "confirm")!;

    // 確認前はシナリオが動かない
    expect(await scheduleDueSteps(ctx)).toEqual([]);

    const c = await confirm(ctx, confirmToken);
    expect(c.status).toBe("confirmed");

    const due = await scheduleDueSteps(ctx);
    expect(due).toHaveLength(1);
    expect(await sendMessage(ctx, due[0]!)).toBe("sent");
    expect(await sendMessage(ctx, due[0]!)).toBe("not-queued"); // 二重送信しない

    const step1 = provider.sent[1]!;
    expect(step1.subject).toBe("山田さん、特典をお届けします");
    expect(step1.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(step1.html).toContain("https://mail.example.com/d/");
    // 置き換え文字（%name% など）が残っていない。レイアウトの width:100% などの % は対象外
    expect(step1.html).not.toMatch(/%[^%\s<>"';:]+%/);
    expect(step1.text).not.toContain("%");

    // 2通目は2日後
    expect(await scheduleDueSteps(ctx)).toEqual([]);
    env.advanceDays(2);
    const due2 = await scheduleDueSteps(ctx);
    expect(due2).toHaveLength(1);
    await sendMessage(ctx, due2[0]!);

    // 全ステップ送信後は完了し、完了タグが付く
    const [e] = await ctx.db.query<{ status: string }>("SELECT status FROM enrollments");
    expect(e!.status).toBe("completed");
    const tags = await ctx.db.query<{ name: string }>(
      "SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id ORDER BY t.name",
    );
    expect(tags.map((t) => t.name)).toEqual(["seo-checklist", "seq:seo:done"]);
  });

  it("tracks human clicks and downloads but ignores instant scanner clicks", async () => {
    const { ctx, provider } = env;
    const sub = await subscribe(ctx, { formSlug: "seo-checklist", email: "a@example.com" });
    if (sub.status !== "confirmation-sent") throw new Error();
    await sendMessage(ctx, sub.messageId);
    await confirm(ctx, extract(provider.sent[0]!.html, "confirm")!);
    const [id] = await scheduleDueSteps(ctx);
    await sendMessage(ctx, id!);
    const html = provider.sent[1]!.html;
    const clickToken = extract(html, "c")!;

    // 配信直後のクリックはボット扱い
    expect(await recordClick(ctx, clickToken, HUMAN)).toBe("https://example.com/lp");
    let [ev] = await ctx.db.query<{ bot_reason: string | null }>("SELECT bot_reason FROM events WHERE type = 'click'");
    expect(ev!.bot_reason).toBe("too-fast");

    env.advanceDays(1);
    await recordClick(ctx, clickToken, HUMAN);
    const human = await ctx.db.query("SELECT 1 FROM events WHERE type = 'click' AND bot_reason IS NULL");
    expect(human).toHaveLength(1);
    // 最後のリンクだったので読了も記録される
    expect(await ctx.db.query("SELECT 1 FROM events WHERE type = 'read'")).toHaveLength(1);

    const dl = await recordDownload(ctx, extract(html, "d")!, HUMAN);
    expect(dl).toBe("https://files.example.com/magnets/seo.pdf?sig=1");
    expect(await ctx.db.query("SELECT 1 FROM events WHERE type = 'goal'")).toHaveLength(1);

    expect(await recordClick(ctx, "forged.token", HUMAN)).toBeUndefined();
  });
});

describe("stopping rules", () => {
  async function activeReader(email: string) {
    const { ctx, provider } = env;
    const sub = await subscribe(ctx, { formSlug: "seo-checklist", email });
    if (sub.status !== "confirmation-sent") throw new Error();
    await sendMessage(ctx, sub.messageId);
    await confirm(ctx, extract(provider.sent.at(-1)!.html, "confirm")!);
    return sub.contactId;
  }

  it("unsubscribe stops sequences and queued mail immediately", async () => {
    const { ctx } = env;
    const id = await activeReader("u@example.com");
    const [queued] = await scheduleDueSteps(ctx);
    await unsubscribe(ctx, id);
    expect(await sendMessage(ctx, queued!)).toBe("not-queued");
    env.advanceDays(3);
    expect(await scheduleDueSteps(ctx)).toEqual([]);
  });

  it("a complaint unsubscribes and a hard bounce stops", async () => {
    const { ctx } = env;
    const a = await activeReader("complain@example.com");
    const [m] = await scheduleDueSteps(ctx);
    await sendMessage(ctx, m!);
    expect(await handleSesEvent(ctx, { eventType: "Complaint", mail: { tags: { message_id: [m!] } } })).toBe("complaint");
    const [ca] = await ctx.db.query<{ status: string }>("SELECT status FROM contacts WHERE id = $1", [a]);
    expect(ca!.status).toBe("unsubscribed");
    // 苦情を出した人はフォームから再登録しても確認メールを送らない
    expect((await subscribe(ctx, { formSlug: "seo-checklist", email: "complain@example.com" })).status).toBe("already-active");

    const b = await activeReader("bounce@example.com");
    const [m2] = await scheduleDueSteps(ctx);
    await sendMessage(ctx, m2!);
    await handleSesEvent(ctx, { eventType: "Bounce", bounce: { bounceType: "Permanent" }, mail: { tags: { message_id: [m2!] } } });
    const [cb] = await ctx.db.query<{ status: string }>("SELECT status FROM contacts WHERE id = $1", [b]);
    expect(cb!.status).toBe("stopped");
  });

  it("three soft bounces pause the reader", async () => {
    const { ctx } = env;
    const id = await activeReader("soft@example.com");
    const [m] = await scheduleDueSteps(ctx);
    await sendMessage(ctx, m!);
    for (let i = 0; i < 3; i++) {
      await handleSesEvent(ctx, { eventType: "Bounce", bounce: { bounceType: "Transient" }, mail: { tags: { message_id: [m!] } } });
    }
    const [c] = await ctx.db.query<{ status: string }>("SELECT status FROM contacts WHERE id = $1", [id]);
    expect(c!.status).toBe("paused");
  });
});

describe("broadcasts", () => {
  it("excludes dormant readers, includes low ones only for important issues, and never duplicates", async () => {
    const { ctx } = env;
    await importContacts(
      ctx.db,
      "email,name\nhot@example.com,A\nlow@example.com,B\nsleep@example.com,C\n",
      { label: "old-list", evidence: "旧サービスでのオプトイン登録" },
    );
    await ctx.db.query("UPDATE contacts SET tier = 'low' WHERE id = (SELECT contact_id FROM channels WHERE address = 'low@example.com')");
    await ctx.db.query("UPDATE contacts SET tier = 'dormant' WHERE id = (SELECT contact_id FROM channels WHERE address = 'sleep@example.com')");
    expect(await countRecipients(ctx, null, false)).toBe(1);
    expect(await countRecipients(ctx, null, true)).toBe(2);
    expect(await countRecipients(ctx, { type: "tag", tag: "old-list", has: true }, true)).toBe(2);
    expect(await countRecipients(ctx, { type: "tag", tag: "other", has: true }, true)).toBe(0);

    await ctx.db.query(
      "INSERT INTO broadcasts (subject, body_markdown, important, scheduled_at, status) VALUES ('号外', '本文 %name%', true, $1, 'scheduled')",
      [ctx.now()],
    );
    const ids = await launchDueBroadcasts(ctx);
    expect(ids).toHaveLength(2);
    expect(await launchDueBroadcasts(ctx)).toHaveLength(0);
    for (const id of ids) expect(await sendMessage(ctx, id)).toBe("sent");
    expect(env.provider.sent.every((m) => m.html.includes("https://mail.example.com/w/"))).toBe(false);
  });
});

describe("scoring", () => {
  it("moves a long-silent reader to dormant, pauses them and starts the re-engagement sequence", async () => {
    const { ctx } = env;
    await importContacts(ctx.db, "email\nquiet@example.com\n", { label: "old", evidence: "test" });
    await ctx.db.query("UPDATE contacts SET created_at = $1, tier = 'low'", [new Date("2026-06-01T00:00:00Z")]);
    const [c] = await ctx.db.query<{ id: string; channel_id: string }>(
      "SELECT c.id, ch.id AS channel_id FROM contacts c JOIN channels ch ON ch.contact_id = c.id",
    );
    // 過去60日間に12通、反応なし
    for (let i = 0; i < 12; i++) {
      const sentAt = new Date(ctx.now().getTime() - (5 + i * 5) * 86_400_000);
      await ctx.db.query(
        `INSERT INTO messages (idempotency_key, contact_id, channel_id, provider, kind, status, sent_at)
         VALUES ($1, $2, $3, 'memory', 'broadcast', 'sent', $4)`,
        [`old:${i}`, c!.id, c!.channel_id, sentAt],
      );
    }
    const summary = await recomputeAllScores(ctx);
    expect(summary.newlyDormant).toBe(1);
    const [after] = await ctx.db.query<{ status: string; tier: string; no_response_streak: number }>(
      "SELECT status, tier, no_response_streak FROM contacts",
    );
    expect(after).toMatchObject({ status: "paused", tier: "dormant", no_response_streak: 12 });

    // 再確認シナリオは paused でも届く
    const due = await scheduleDueSteps(ctx);
    expect(due).toHaveLength(1);
    expect(await sendMessage(ctx, due[0]!)).toBe("sent");

    // 反応がないまま猶予が過ぎると停止
    env.advanceDays(8);
    await scheduleDueSteps(ctx);
    const [stopped] = await ctx.db.query<{ status: string }>("SELECT status FROM contacts");
    expect(stopped!.status).toBe("stopped");
  });
});

describe("import", () => {
  it("parses quoted CSV and skips existing addresses", async () => {
    expect(parseCsv('email,name\n"a@example.com","山田, 太郎"\n')).toEqual([["email", "name"], ["a@example.com", "山田, 太郎"]]);
    const r1 = await importContacts(env.ctx.db, "email,attr.job\na@example.com,編集者\nbad\n", { label: "x", evidence: "e" });
    expect(r1).toMatchObject({ imported: 1, skippedExisting: 0 });
    expect(r1.invalid).toHaveLength(1);
    const r2 = await importContacts(env.ctx.db, "email\na@example.com\n", { label: "x", evidence: "e" });
    expect(r2.skippedExisting).toBe(1);
  });
});

describe("nextSendAt", () => {
  it("handles JST send times", () => {
    const base = new Date("2026-11-13T03:00:00Z"); // JST 12:00
    expect(nextSendAt(base, 1, "07:00").toISOString()).toBe("2026-11-13T22:00:00.000Z"); // 翌日 JST 7:00
    expect(nextSendAt(base, 0, "07:00").toISOString()).toBe("2026-11-13T22:00:00.000Z"); // 当日分は過ぎたので翌日
    expect(nextSendAt(base, 0, "20:00").toISOString()).toBe("2026-11-13T11:00:00.000Z");
    expect(nextSendAt(base, 2, null).toISOString()).toBe("2026-11-15T03:00:00.000Z");
  });
});

describe("legal footer", () => {
  it("does not send while the sender address or other legal fields are missing", async () => {
    const { ctx } = env;
    const sub = await subscribe(ctx, { formSlug: "seo-checklist", email: "legal@example.com" });
    if (sub.status !== "confirmation-sent") throw new Error();
    ctx.settings = { ...ctx.settings, senderAddress: "" };
    expect(await sendMessage(ctx, sub.messageId)).toBe("retry");
    expect(env.provider.sent).toHaveLength(0);
    const [m] = await ctx.db.query<{ status: string; error: string }>("SELECT status, error FROM messages");
    expect(m!.status).toBe("queued");
    expect(m!.error).toContain("senderAddress");
  });
});

describe("backup and pruning", () => {
  it("exports core tables and removes old events", async () => {
    const { ctx } = env;
    const { exportAll, pruneOldData } = await import("../src/services/backup.js");
    await importContacts(ctx.db, "email\nb@example.com\n", { label: "x", evidence: "e" });
    const files: Record<string, string> = {};
    const counts = await exportAll(ctx.db, { write: async (n, d) => void (files[n] = d) }, ctx.now());
    expect(counts.contacts).toBe(1);
    expect(files.channels).toContain("b@example.com");
    expect(Object.keys(files)).toContain("events_recent");

    const [c] = await ctx.db.query<{ id: string }>("SELECT id FROM contacts");
    await ctx.db.query("INSERT INTO events (contact_id, type, occurred_at) VALUES ($1, 'open', $2), ($1, 'open', $3)", [
      c!.id,
      new Date("2024-01-01T00:00:00Z"),
      ctx.now(),
    ]);
    expect((await pruneOldData(ctx.db, ctx.now())).events).toBe(1);
    expect(await ctx.db.query("SELECT 1 FROM events")).toHaveLength(1);
  });
});

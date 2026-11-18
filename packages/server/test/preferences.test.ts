import { createToken } from "@tsuzuri/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { countRecipients, launchDueBroadcasts } from "../src/services/broadcasts.js";
import { importContacts } from "../src/services/import.js";
import { getPreferences, savePreferences } from "../src/services/preferences.js";
import { sendMessage } from "../src/services/sending.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { createEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let news: string;
let promo: string;
let optIn: string;
let a: string;
let b: string;

beforeEach(async () => {
  env = await createEnv();
  const db = env.ctx.db;
  [news, promo, optIn] = (
    await db.query<{ id: string }>(
      `INSERT INTO topics (slug, name, default_subscribed, position) VALUES
         ('newsletter', 'メルマガ本誌', true, 1), ('campaign', 'キャンペーン', true, 2), ('beta', '先行案内', false, 3)
       RETURNING id`,
    )
  ).map((r) => r.id) as [string, string, string];
  await importContacts(db, "email\na@example.com\nb@example.com\n", { label: "x", evidence: "e" });
  const ids = await db.query<{ id: string; address: string }>(
    "SELECT c.id, ch.address FROM contacts c JOIN channels ch ON ch.contact_id = c.id ORDER BY ch.address",
  );
  a = ids[0]!.id;
  b = ids[1]!.id;
});

describe("topics", () => {
  it("defaults follow each topic and opt-outs exclude readers from that topic only", async () => {
    const { ctx } = env;
    expect(await countRecipients(ctx, null, false, news)).toBe(2);
    expect(await countRecipients(ctx, null, false, optIn)).toBe(0);

    await savePreferences(ctx, a, { subscribedTopicIds: [news, optIn], pauseDays: 0 });
    expect(await countRecipients(ctx, null, false, news)).toBe(2);
    expect(await countRecipients(ctx, null, false, promo)).toBe(1);
    expect(await countRecipients(ctx, null, false, optIn)).toBe(1);
    expect(await countRecipients(ctx, null, false, null)).toBe(2);

    const prefs = await getPreferences(ctx, a);
    expect(prefs?.topics.map((t) => [t.name, t.subscribed])).toEqual([
      ["メルマガ本誌", true],
      ["キャンペーン", false],
      ["先行案内", true],
    ]);
  });

  it("does not send a queued broadcast to someone who opted out after it was queued", async () => {
    const { ctx } = env;
    await ctx.db.query(
      "INSERT INTO broadcasts (subject, body_markdown, topic_id, scheduled_at, status) VALUES ('キャンペーン', '本文', $1, $2, 'scheduled')",
      [promo, ctx.now()],
    );
    const ids = await launchDueBroadcasts(ctx);
    expect(ids).toHaveLength(2);
    await savePreferences(ctx, b, { subscribedTopicIds: [news], pauseDays: 0 });
    const outcomes = await Promise.all(ids.map((id) => sendMessage(ctx, id)));
    expect(outcomes.sort()).toEqual(["sent", "skipped"]);
  });
});

describe("pause", () => {
  it("excludes paused readers from broadcasts and postpones their sequences until the pause ends", async () => {
    const { ctx } = env;
    await savePreferences(ctx, a, { subscribedTopicIds: [news, promo], pauseDays: 30 });
    expect(await countRecipients(ctx, null, false)).toBe(1);

    const [seq] = await ctx.db.query<{ id: string }>("INSERT INTO sequences (slug, name, status) VALUES ('s', 's', 'active') RETURNING id");
    await ctx.db.query("INSERT INTO sequence_steps (sequence_id, position, delay_days, subject, body_markdown) VALUES ($1, 1, 0, 'x', 'y')", [seq!.id]);
    await ctx.db.query("INSERT INTO enrollments (contact_id, sequence_id, next_position, next_send_at) VALUES ($1, $2, 1, $3)", [a, seq!.id, ctx.now()]);
    expect(await scheduleDueSteps(ctx)).toEqual([]);
    const [e] = await ctx.db.query<{ next_send_at: Date; status: string }>("SELECT next_send_at, status FROM enrollments");
    expect(e!.status).toBe("active");
    expect(new Date(e!.next_send_at).getTime()).toBe(ctx.now().getTime() + 30 * 86_400_000);

    env.advanceDays(31);
    expect(await scheduleDueSteps(ctx)).toHaveLength(1);
    expect(await countRecipients(ctx, null, false)).toBe(2);
  });

  it("stops a sequence whose topic the reader opted out of", async () => {
    const { ctx } = env;
    const [seq] = await ctx.db.query<{ id: string }>(
      "INSERT INTO sequences (slug, name, status, topic_id) VALUES ('s', 's', 'active', $1) RETURNING id",
      [promo],
    );
    await ctx.db.query("INSERT INTO sequence_steps (sequence_id, position, delay_days, subject, body_markdown) VALUES ($1, 1, 0, 'x', 'y')", [seq!.id]);
    await ctx.db.query("INSERT INTO enrollments (contact_id, sequence_id, next_position, next_send_at) VALUES ($1, $2, 1, $3)", [b, seq!.id, ctx.now()]);
    await savePreferences(ctx, b, { subscribedTopicIds: [news], pauseDays: 0 });
    expect(await scheduleDueSteps(ctx)).toEqual([]);
    const [e] = await ctx.db.query<{ status: string }>("SELECT status FROM enrollments");
    expect(e!.status).toBe("stopped");
  });
});

describe("preferences page", () => {
  it("shows the reader's choices and saves them", async () => {
    const app = createApp(async () => env.ctx, { enqueue: async () => {} });
    const token = createToken("preferences", a, env.ctx.secret);
    const html = await (await app.request(`/p/${token}`)).text();
    expect(html).toContain("メルマガ本誌");
    expect(html).toContain("30 日間お休みする");
    expect(html).toContain("/u/");

    const body = new URLSearchParams();
    body.append("topics", news);
    body.append("topics", "00000000-0000-0000-0000-000000000000"); // 存在しない種類は無視される
    body.append("pause", "90");
    const res = await app.request(`/p/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(303);
    const prefs = await getPreferences(env.ctx, a);
    expect(prefs?.topics.filter((t) => t.subscribed).map((t) => t.name)).toEqual(["メルマガ本誌"]);
    expect(prefs?.pausedUntil?.getTime()).toBe(env.ctx.now().getTime() + 90 * 86_400_000);
    expect(await (await app.request(`/p/${token}?saved=1`)).text()).toContain("保存しました");
    expect((await app.request("/p/forged.token")).status).toBe(400);
  });

  it("does not let an unsubscribed reader change preferences", async () => {
    await env.ctx.db.query("UPDATE contacts SET status = 'unsubscribed' WHERE id = $1", [a]);
    expect(await savePreferences(env.ctx, a, { subscribedTopicIds: [], pauseDays: 30 })).toBe(false);
  });
});

describe("pause keep", () => {
  it("keeps an existing pause when the reader saves without changing it", async () => {
    await savePreferences(env.ctx, a, { subscribedTopicIds: [news], pauseDays: 30 });
    const before = (await getPreferences(env.ctx, a))?.pausedUntil?.getTime();
    env.advanceDays(1);
    await savePreferences(env.ctx, a, { subscribedTopicIds: [news, promo], pauseDays: "keep" });
    expect((await getPreferences(env.ctx, a))?.pausedUntil?.getTime()).toBe(before);
    await savePreferences(env.ctx, a, { subscribedTopicIds: [news], pauseDays: 0 });
    expect((await getPreferences(env.ctx, a))?.pausedUntil).toBeNull();
  });
});

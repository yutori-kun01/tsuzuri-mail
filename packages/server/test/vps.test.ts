import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { rateLimit } from "../src/http/ratelimit.js";
import { LocalFileStorage } from "../src/providers/local.js";
import { importContacts } from "../src/services/import.js";
import { dueQueuedMessages } from "../src/services/queue.js";
import { sendMessage } from "../src/services/sending.js";
import { parseSesEventBody } from "../src/vps/ses-events.js";
import { createEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await createEnv();
});

describe("dueQueuedMessages", () => {
  it("waits longer before retrying each failed message", async () => {
    const { ctx } = env;
    await importContacts(ctx.db, "email\na@example.com\n", { label: "x", evidence: "e" });
    const [c] = await ctx.db.query<{ id: string; ch: string }>("SELECT c.id, ch.id AS ch FROM contacts c JOIN channels ch ON ch.contact_id = c.id");
    await ctx.db.query(
      "INSERT INTO broadcasts (id, subject, body_markdown, status) VALUES ('00000000-0000-0000-0000-0000000000b1', 's', 'b', 'sent')",
    );
    const [m] = await ctx.db.query<{ id: string }>(
      `INSERT INTO messages (idempotency_key, contact_id, channel_id, broadcast_id, provider, kind)
       VALUES ('bc:1', $1, $2, '00000000-0000-0000-0000-0000000000b1', 'memory', 'broadcast') RETURNING id`,
      [c!.id, c!.ch],
    );
    expect(await dueQueuedMessages(ctx)).toEqual([m!.id]);

    // 送信に失敗させる → 2 分は拾わない
    const original = env.provider.send.bind(env.provider);
    env.provider.send = async () => {
      throw new Error("Throttling");
    };
    expect(await sendMessage(ctx, m!.id)).toBe("retry");
    expect(await dueQueuedMessages(ctx)).toEqual([]);
    env.setNow(new Date(ctx.now().getTime() + 3 * 60_000));
    expect(await dueQueuedMessages(ctx)).toEqual([m!.id]);

    env.provider.send = original;
    expect(await sendMessage(ctx, m!.id)).toBe("sent");
    expect(await dueQueuedMessages(ctx)).toEqual([]);
  });
});

describe("rateLimit", () => {
  it("limits requests per IP and window", async () => {
    let t = 0;
    const app = new Hono();
    app.use("*", rateLimit([{ name: "x", match: () => true, limit: 2, windowMs: 1000 }], () => t));
    app.get("/", (c) => c.text("ok"));
    // 手前のプロキシが最後に付けた値で数える（先頭は読者が偽って送れる）
    const req = (ip: string, forged = "6.6.6.6") => app.request("/", { headers: { "x-forwarded-for": `${forged}, ${ip}` } });
    expect((await req("1.1.1.1")).status).toBe(200);
    expect((await req("1.1.1.1")).status).toBe(200);
    const blocked = await req("1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect((await req("2.2.2.2")).status).toBe(200);
    // 先頭を変えても、同じ接続元なら制限は外れない
    expect((await req("1.1.1.1", "9.9.9.9")).status).toBe(429);
    t = 1500;
    expect((await req("1.1.1.1")).status).toBe(200);
  });
});

describe("parseSesEventBody", () => {
  const ses = { eventType: "Bounce", bounce: { bounceType: "Permanent" }, mail: { messageId: "m" } };
  it("unwraps the SNS envelope and accepts raw delivery", () => {
    expect(parseSesEventBody(JSON.stringify({ Type: "Notification", Message: JSON.stringify(ses) }))).toEqual(ses);
    expect(parseSesEventBody(JSON.stringify(ses))).toEqual(ses);
    expect(parseSesEventBody("not json")).toBeUndefined();
    expect(parseSesEventBody(JSON.stringify({ Type: "SubscriptionConfirmation" }))).toBeUndefined();
  });
});

describe("LocalFileStorage", () => {
  it("serves files only with a valid, unexpired token inside the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsuzuri-files-"));
    await mkdir(join(dir, "magnets"));
    await writeFile(join(dir, "magnets", "特典.pdf"), "%PDF-1.4 test");
    let now = new Date("2026-11-13T00:00:00Z");
    const storage = new LocalFileStorage(dir, "https://mail.example.com", env.ctx.secret, () => now);
    env.ctx.storage = storage;
    const app = createApp(async () => env.ctx, { enqueue: async () => {} });

    const link = await storage.downloadUrl("magnets/特典.pdf");
    const path = new URL(link).pathname;
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("%PDF-1.4 test");

    // ディレクトリの外は配らない
    const escape = new URL(await storage.downloadUrl("../../etc/passwd")).pathname;
    expect((await app.request(escape)).status).toBe(404);
    // 期限切れ
    now = new Date(now.getTime() + 11 * 60_000);
    expect((await app.request(path)).status).toBe(404);
    expect((await app.request("/files/forged.token")).status).toBe(404);
  });
});

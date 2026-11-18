import { describe, expect, it } from "vitest";
import { launchDueBroadcasts, pickWinner } from "../src/services/broadcasts.js";
import { dueQueuedMessages } from "../src/services/queue.js";
import { addContactManually } from "../src/services/readers.js";
import { sendMessage } from "../src/services/sending.js";
import { createEnv } from "./helpers.js";

const base = new Date("2026-11-13T01:30:00Z"); // 日本時間 10:30

async function readers(env: Awaited<ReturnType<typeof createEnv>>, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await addContactManually(env.ctx, { email: `r${i}@example.com`, evidence: "t" });
    if (r.status === "added") ids.push(r.contactId);
  }
  return ids;
}

describe("subject A/B test", () => {
  it("picks the variant with the higher human click rate", () => {
    expect(pickWinner([{ variant: "a", total: 10, sent: 10, clicked: 1, opened: 5 }, { variant: "b", total: 10, sent: 10, clicked: 2, opened: 1 }])).toBe("b");
    expect(pickWinner([{ variant: "a", total: 10, sent: 10, clicked: 0, opened: 1 }, { variant: "b", total: 10, sent: 10, clicked: 0, opened: 1 }])).toBe("a");
  });

  it("sends to a test share first, then the winning subject to everyone else", async () => {
    const env = await createEnv(base);
    await readers(env, 20);
    const [b] = await env.ctx.db.query<{ id: string }>(
      `INSERT INTO broadcasts (subject, subject_b, ab_percent, ab_wait_minutes, body_markdown, status, scheduled_at)
       VALUES ('件名A', '件名B', 20, 60, '本文', 'scheduled', $1) RETURNING id`,
      [base],
    );
    const test = await launchDueBroadcasts(env.ctx);
    expect(test).toHaveLength(4); // 20 人の 20% を A・B に半分ずつ
    for (const id of test) await sendMessage(env.ctx, id);
    expect(env.provider.sent.map((m) => m.subject).sort()).toEqual(["件名A", "件名A", "件名B", "件名B"]);
    const [status] = await env.ctx.db.query<{ status: string }>("SELECT status FROM broadcasts WHERE id = $1", [b!.id]);
    expect(status!.status).toBe("testing");

    // B を受け取った人が本文のリンクを押した
    const [bMsg] = await env.ctx.db.query<{ id: string; contact_id: string }>("SELECT id, contact_id FROM messages WHERE variant = 'b' LIMIT 1");
    await env.ctx.db.query("INSERT INTO events (contact_id, message_id, type, data, occurred_at) VALUES ($1, $2, 'click', '{}', $3)", [
      bMsg!.contact_id,
      bMsg!.id,
      base,
    ]);
    env.setNow(new Date(base.getTime() + 59 * 60_000));
    expect(await launchDueBroadcasts(env.ctx)).toHaveLength(0);
    env.setNow(new Date(base.getTime() + 60 * 60_000));
    const rest = await launchDueBroadcasts(env.ctx);
    expect(rest).toHaveLength(16);
    const [after] = await env.ctx.db.query<{ status: string; ab_winner: string }>("SELECT status, ab_winner FROM broadcasts WHERE id = $1", [b!.id]);
    expect(after).toEqual({ status: "sent", ab_winner: "b" });
    await sendMessage(env.ctx, rest[0]!);
    expect(env.provider.sent.at(-1)!.subject).toBe("件名B");
  });
});

describe("send time optimization", () => {
  it("delays readers to the hour they usually click, within 24 hours", async () => {
    const env = await createEnv(base);
    const [clicker, quiet] = await readers(env, 2);
    // 日本時間 21 時台に 3 回押している
    for (const day of [1, 2, 3]) {
      await env.ctx.db.query("INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'click', '{}', $2)", [
        clicker,
        new Date(Date.UTC(2026, 10, day, 12, 15)),
      ]);
    }
    await env.ctx.db.query(
      "INSERT INTO broadcasts (subject, body_markdown, status, scheduled_at, optimize_send_time) VALUES ('s', 'b', 'scheduled', $1, true)",
      [base],
    );
    await launchDueBroadcasts(env.ctx);
    const rows = await env.ctx.db.query<{ contact_id: string; send_after: Date | null }>("SELECT contact_id, send_after FROM messages");
    expect(rows.find((r) => r.contact_id === clicker)!.send_after).toEqual(new Date("2026-11-13T12:00:00Z")); // 同じ日の 21:00
    expect(rows.find((r) => r.contact_id === quiet)!.send_after).toBeNull();
    expect(await dueQueuedMessages(env.ctx)).toHaveLength(1); // 21 時まで待つ人は、まだ拾わない
    env.setNow(new Date("2026-11-13T12:00:00Z"));
    expect(await dueQueuedMessages(env.ctx)).toHaveLength(2);
  });
});

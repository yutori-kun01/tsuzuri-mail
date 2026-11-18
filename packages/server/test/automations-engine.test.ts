import { describe, expect, it } from "vitest";
import { runAutomations, ruleMatches } from "../src/services/automations.js";
import { addContactManually } from "../src/services/readers.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { createEnv } from "./helpers.js";

describe("automation rules", () => {
  it("matches links by substring and other triggers exactly", () => {
    expect(ruleMatches({ trigger_type: "link_click", trigger_value: "example.com/course" }, { type: "link_click", value: "https://example.com/course?utm=x" })).toBe(true);
    expect(ruleMatches({ trigger_type: "tag_added", trigger_value: "講座" }, { type: "tag_added", value: "講座に興味" })).toBe(false);
  });

  it("chains click → tag → scenario → next scenario, once per reader", async () => {
    const env = await createEnv();
    const db = env.ctx.db;
    const seq = async (slug: string) =>
      (await db.query<{ id: string }>("INSERT INTO sequences (slug, name, status) VALUES ($1, $1, 'active') RETURNING id", [slug]))[0]!.id;
    const guide = await seq("guide");
    const next = await seq("next");
    for (const s of [guide, next]) {
      await db.query("INSERT INTO sequence_steps (sequence_id, position, delay_minutes, subject, body_markdown) VALUES ($1, 1, 0, 's', 'b')", [s]);
    }
    await db.query(
      `INSERT INTO automation_rules (name, trigger_type, trigger_value, action_type, action_value) VALUES
         ('r1', 'link_click', 'example.com/course', 'add_tag', '講座に興味'),
         ('r2', 'tag_added', '講座に興味', 'start_sequence', $1),
         ('r3', 'sequence_completed', $1, 'start_sequence', $2)`,
      [guide, next],
    );
    await runAutomations(env.ctx); // 初回：基準の時刻を記録
    const r = await addContactManually(env.ctx, { email: "a@example.com", evidence: "t" });
    if (r.status !== "added") throw new Error("setup");

    // 人のクリック（ボットのクリックは数えない）
    await db.query(
      `INSERT INTO events (contact_id, type, data, occurred_at, bot_reason) VALUES
         ($1, 'click', '{"url":"https://bot.example.com/course"}', $2, 'prefetch'),
         ($1, 'click', '{"url":"https://example.com/course?x=1"}', $2, NULL)`,
      [r.contactId, env.ctx.now()],
    );
    env.setNow(new Date(env.ctx.now().getTime() + 60_000));
    expect((await runAutomations(env.ctx)).ran).toBe(1); // タグ
    env.setNow(new Date(env.ctx.now().getTime() + 60_000));
    expect((await runAutomations(env.ctx)).ran).toBe(1); // シナリオ開始
    expect(await scheduleDueSteps(env.ctx)).toHaveLength(1);
    // 1 通だけのシナリオなので、次の処理で完了する
    env.setNow(new Date(env.ctx.now().getTime() + 60_000));
    await scheduleDueSteps(env.ctx);
    env.setNow(new Date(env.ctx.now().getTime() + 60_000));
    expect((await runAutomations(env.ctx)).ran).toBe(1); // 次のシナリオ
    const enrolled = await db.query<{ sequence_id: string }>("SELECT sequence_id FROM enrollments WHERE contact_id = $1 ORDER BY enrolled_at", [r.contactId]);
    expect(enrolled.map((e) => e.sequence_id)).toEqual([guide, next]);

    // もう一度押しても、同じルールは同じ読者に 1 回だけ
    await db.query(`INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'click', '{"url":"https://example.com/course"}', $2)`, [
      r.contactId,
      env.ctx.now(),
    ]);
    env.setNow(new Date(env.ctx.now().getTime() + 60_000));
    expect((await runAutomations(env.ctx)).ran).toBe(0);
  });
});

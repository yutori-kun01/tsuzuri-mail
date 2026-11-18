import { describe, expect, it } from "vitest";
import { addContactManually } from "../src/services/readers.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { describeTiming, stepSendAt } from "../src/time.js";
import { createEnv } from "./helpers.js";

describe("step timing", () => {
  const base = new Date("2026-11-13T01:30:00Z"); // 日本時間 10:30

  it("supports right away, minutes/hours later, and days later at a time", () => {
    expect(stepSendAt(base, { delay_days: 0, send_time: null, delay_minutes: 0 })).toEqual(base);
    expect(stepSendAt(base, { delay_days: 0, send_time: null, delay_minutes: 180 })).toEqual(new Date("2026-11-13T04:30:00Z"));
    // 2 日後の日本時間 8:00
    expect(stepSendAt(base, { delay_days: 2, send_time: "08:00:00", delay_minutes: null })).toEqual(new Date("2026-11-14T23:00:00Z"));
    // 0 日後 8:00 は、もう過ぎているので翌日の 8:00
    expect(stepSendAt(base, { delay_days: 0, send_time: "08:00", delay_minutes: null })).toEqual(new Date("2026-11-13T23:00:00Z"));

    expect(describeTiming({ delay_days: 0, send_time: null, delay_minutes: 0 }, true)).toBe("登録後すぐ");
    expect(describeTiming({ delay_days: 0, send_time: null, delay_minutes: 90 }, false)).toBe("前の通から 1 時間 30 分後");
    expect(describeTiming({ delay_days: 3, send_time: "08:00:00", delay_minutes: null }, false)).toBe("前の通から 3 日後 08:00");
  });

  it("sends the first step right after enrollment and the next one 3 hours later", async () => {
    const env = await createEnv(base);
    const [seq] = await env.ctx.db.query<{ id: string }>("INSERT INTO sequences (slug, name, status) VALUES ('t', 'T', 'active') RETURNING id");
    await env.ctx.db.query(
      `INSERT INTO sequence_steps (sequence_id, position, delay_days, delay_minutes, subject, body_markdown) VALUES
         ($1, 1, 0, 0, '1 通目', 'a'), ($1, 2, 0, 180, '2 通目', 'b'), ($1, 3, 1, NULL, '3 通目', 'c')`,
      [seq!.id],
    );
    await addContactManually(env.ctx, { email: "r@example.com", evidence: "test", sequenceId: seq!.id });
    expect(await scheduleDueSteps(env.ctx)).toHaveLength(1); // すぐ
    env.setNow(new Date(base.getTime() + 179 * 60_000));
    expect(await scheduleDueSteps(env.ctx)).toHaveLength(0);
    env.setNow(new Date(base.getTime() + 180 * 60_000));
    expect(await scheduleDueSteps(env.ctx)).toHaveLength(1); // 3 時間後
    env.setNow(new Date(base.getTime() + 180 * 60_000 + 86_400_000));
    expect(await scheduleDueSteps(env.ctx)).toHaveLength(1); // その 1 日後
  });
});

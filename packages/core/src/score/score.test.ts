import { describe, expect, it } from "vitest";
import {
  activityPoints,
  computeScore,
  decay,
  decideTier,
  smoothedRate,
  type EngagementEvent,
  type ScoreInput,
} from "./score.js";
import { defaultScoreSettings as s } from "./settings.js";

const now = new Date("2026-11-13T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    now,
    subscribedAt: daysAgo(120),
    events: [],
    window: { delivered: 20, clicked: 0, read: 0 },
    population: { clickRate: 0.1, readRate: 0.2 },
    noResponseStreak: 0,
    ...over,
  };
}

describe("decay", () => {
  it("halves at the half-life", () => {
    expect(decay(30, 30)).toBeCloseTo(0.5);
    expect(decay(0, 30)).toBe(1);
  });
  it("treats future events as age 0", () => {
    expect(decay(-5, 30)).toBe(1);
  });
});

describe("activityPoints", () => {
  it("counts repeat clicks on the same message at the reduced weight", () => {
    const events: EngagementEvent[] = [
      { type: "click", occurredAt: now, messageId: "m1" },
      { type: "click", occurredAt: now, messageId: "m1" },
      { type: "click", occurredAt: now, messageId: "m2" },
    ];
    expect(activityPoints(events, now)).toBe(s.weights.click * 2 + s.weights.repeatClick);
  });
  it("weights machine opens lower than human opens", () => {
    const human = activityPoints([{ type: "open", occurredAt: now }], now);
    const machine = activityPoints([{ type: "open", occurredAt: now, machine: true }], now);
    expect(machine).toBeLessThan(human);
  });
  it("uses the goal's own weight when given", () => {
    expect(activityPoints([{ type: "goal", occurredAt: now, weight: 30 }], now)).toBe(30);
  });
});

describe("smoothedRate", () => {
  it("pulls small samples toward the population rate", () => {
    // 1通受信して1クリック → 生の率は100%だが、平均10%に寄せられる
    expect(smoothedRate(1, 1, 0.1, 5)).toBeCloseTo((1 + 0.5) / 6);
  });
});

describe("computeScore", () => {
  it("keeps new readers in evaluation with the fixed score", () => {
    const r = computeScore(input({ subscribedAt: daysAgo(3) }));
    expect(r.tier).toBe("evaluating");
    expect(r.score).toBe(s.evaluation.fixedScore);
  });

  it("keeps readers with few deliveries in evaluation", () => {
    const r = computeScore(input({ window: { delivered: 2, clicked: 0, read: 0 } }));
    expect(r.tier).toBe("evaluating");
  });

  it("scores an engaged reader as hot", () => {
    const events: EngagementEvent[] = Array.from({ length: 6 }, (_, i) => ({
      type: "click" as const,
      occurredAt: daysAgo(i * 3),
      messageId: `m${i}`,
    }));
    const r = computeScore(input({ events, window: { delivered: 20, clicked: 8, read: 8 } }));
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.tier).toBe("hot");
  });

  it("marks a long-silent reader as dormant only after the no-response streak", () => {
    const silent = input({ window: { delivered: 20, clicked: 0, read: 0 } });
    expect(computeScore({ ...silent, noResponseStreak: 3 }).tier).toBe("low");
    expect(computeScore({ ...silent, noResponseStreak: 12 }).tier).toBe("dormant");
  });

  it("never goes below 0 or above 100", () => {
    const ignored: EngagementEvent[] = Array.from({ length: 50 }, () => ({ type: "ignored" as const, occurredAt: now }));
    const r = computeScore(input({ events: ignored }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe("decideTier hysteresis", () => {
  it("does not move up until the boundary is cleared by the margin", () => {
    expect(decideTier(72, 0, "normal")).toBe("normal");
    expect(decideTier(75, 0, "normal")).toBe("hot");
  });
  it("does not move down until the boundary is undercut by the margin", () => {
    expect(decideTier(67, 0, "hot")).toBe("hot");
    expect(decideTier(64, 0, "hot")).toBe("normal");
  });
  it("moves to dormant as soon as the streak condition is met", () => {
    expect(decideTier(10, 10, "low")).toBe("dormant");
  });
});

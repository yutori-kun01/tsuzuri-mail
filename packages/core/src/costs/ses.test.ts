import { describe, expect, it } from "vitest";
import { estimateMonthlySes, projectMonth, sesCostUsd } from "./ses.js";

describe("SES cost", () => {
  it("multiplies emails by the price per 1,000", () => {
    expect(sesCostUsd(40_000, 0.1)).toBeCloseTo(4);
    expect(sesCostUsd(0, 0.1)).toBe(0);
    expect(sesCostUsd(1000, -1)).toBe(0);
  });

  it("estimates a month from readers, broadcasts and signups", () => {
    // docs/requirements.md の目安：1 万人に週 1 回なら月 4 万通強
    const e = estimateMonthlySes({ readers: 10_000, broadcastsPerMonth: 4, signupsPerMonth: 300, stepsPerSignup: 7, confirmationEmail: true }, 0.1);
    expect(e).toEqual({ broadcastEmails: 40_000, sequenceEmails: 2_100, confirmationEmails: 300, total: 42_400, usd: e.usd });
    expect(e.usd).toBeCloseTo(4.24);
  });

  it("projects the month from the days so far", () => {
    expect(projectMonth(1000, 10, 30)).toBe(3000);
    expect(projectMonth(1000, 0, 30)).toBe(1000);
  });
});

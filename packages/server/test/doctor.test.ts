import { describe, expect, it } from "vitest";
import { runDoctor, formatDoctor, type SesLike } from "../src/services/doctor.js";
import { createEnv } from "./helpers.js";

function fakeSes(overrides: Record<string, unknown> = {}): SesLike {
  const responses: Record<string, unknown> = {
    GetEmailIdentityCommand: { VerifiedForSendingStatus: true, DkimAttributes: { Status: "SUCCESS" }, MailFromAttributes: { MailFromDomainStatus: "SUCCESS" } },
    GetAccountCommand: { ProductionAccessEnabled: false, SendQuota: { Max24HourSend: 200, MaxSendRate: 1 }, SuppressionAttributes: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] } },
    GetConfigurationSetCommand: { SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] } },
    GetConfigurationSetEventDestinationsCommand: { EventDestinations: [{ Enabled: true, MatchingEventTypes: ["DELIVERY", "BOUNCE", "COMPLAINT", "REJECT"] }] },
    ...overrides,
  };
  return { send: async (cmd: unknown) => responses[(cmd as object).constructor.name] };
}

describe("doctor", () => {
  it("passes a ready setup and reports the sandbox as a warning", async () => {
    const env = await createEnv();
    env.ctx.secret = "x".repeat(48);
    env.ctx.settings.testRecipients = ["owner@example.com"];
    const results = await runDoctor(env.ctx, { ses: fakeSes(), env: { SES_EVENTS_QUEUE_URL: "https://sqs/q", MAX_SEND_RATE: "1" } });
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.find((r) => r.name === "本番アクセス")?.status).toBe("warn");
    expect(formatDoctor(results)).toContain("✓ SES の ID ml.example.com");
  });

  it("flags missing legal info, unverified domains, missing suppression and a too-high send rate", async () => {
    const env = await createEnv();
    env.ctx.settings = { ...env.ctx.settings, senderAddress: "", contact: "" };
    env.ctx.secret = "local-development-secret-not-for-production";
    const results = await runDoctor(env.ctx, {
      ses: fakeSes({
        GetEmailIdentityCommand: { VerifiedForSendingStatus: false, DkimAttributes: { Status: "PENDING" }, MailFromAttributes: { MailFromDomainStatus: "PENDING" } },
        GetAccountCommand: { ProductionAccessEnabled: false, SendQuota: { MaxSendRate: 1 }, SuppressionAttributes: { SuppressedReasons: [] } },
      }),
      env: { MAX_SEND_RATE: "5" },
    });
    const failed = results.filter((r) => r.status === "fail").map((r) => r.name);
    expect(failed).toEqual(expect.arrayContaining(["法定表示", "署名用の鍵", "SES の ID ml.example.com", "アカウントの抑制リスト", "送信レート"]));
    expect(formatDoctor(results)).toContain("申請の前に直してください");
  });

  it("skips AWS checks without credentials", async () => {
    const env = await createEnv();
    const results = await runDoctor(env.ctx, {});
    expect(results.find((r) => r.name === "SES")?.status).toBe("skip");
  });
});

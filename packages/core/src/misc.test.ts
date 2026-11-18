import { describe, expect, it } from "vitest";
import { botClickReason, isLikelyMachineOpen } from "./tracking/filters.js";
import { idempotencyKey, listUnsubscribeHeaders } from "./mail/headers.js";
import { MemoryProvider } from "./mail/provider.js";
import { createToken, verifyToken } from "./security/tokens.js";

const delivered = new Date("2026-11-13T00:00:00Z");
const at = (sec: number) => new Date(delivered.getTime() + sec * 1000);
const browserUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

describe("botClickReason", () => {
  const base = {
    method: "GET",
    userAgent: browserUA,
    deliveredAt: delivered,
    clickedAt: at(600),
    linksInMessage: 4,
    distinctLinksClickedInBurst: 1,
  };
  it("accepts an ordinary human click", () => {
    expect(botClickReason(base)).toBeUndefined();
  });
  it("rejects HEAD requests, scanners, instant clicks and all-link bursts", () => {
    expect(botClickReason({ ...base, method: "HEAD" })).toBe("head-request");
    expect(botClickReason({ ...base, userAgent: "Proofpoint URL Defense" })).toBe("scanner-user-agent");
    expect(botClickReason({ ...base, clickedAt: at(3) })).toBe("too-fast");
    expect(botClickReason({ ...base, distinctLinksClickedInBurst: 4 })).toBe("all-links-burst");
    expect(botClickReason({ ...base, userAgent: undefined })).toBe("no-user-agent");
  });
});

describe("isLikelyMachineOpen", () => {
  it("flags bare user agents and instant opens", () => {
    expect(isLikelyMachineOpen({ userAgent: "Mozilla/5.0", deliveredAt: delivered, openedAt: at(600) })).toBe(true);
    expect(isLikelyMachineOpen({ userAgent: browserUA, deliveredAt: delivered, openedAt: at(2) })).toBe(true);
    expect(isLikelyMachineOpen({ userAgent: browserUA, deliveredAt: delivered, openedAt: at(600) })).toBe(false);
  });
});

describe("listUnsubscribeHeaders", () => {
  it("builds RFC 8058 one-click headers", () => {
    const h = listUnsubscribeHeaders("https://example.com/u/abc");
    expect(h["List-Unsubscribe"]).toBe("<https://example.com/u/abc>");
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
  it("rejects non-https URLs", () => {
    expect(() => listUnsubscribeHeaders("http://example.com/u")).toThrow();
    expect(() => listUnsubscribeHeaders("http://localhost:8787/u/x")).not.toThrow();
  });
});

describe("idempotencyKey", () => {
  it("is stable for the same step and reader", () => {
    expect(idempotencyKey.sequenceStep("e1", "s1")).toBe(idempotencyKey.sequenceStep("e1", "s1"));
    expect(idempotencyKey.broadcast("b1", "c1")).not.toBe(idempotencyKey.broadcast("b1", "c2"));
  });
});

describe("tokens", () => {
  const secret = "x".repeat(32);
  it("round-trips the contact id", () => {
    const t = createToken("unsubscribe", "contact-123", secret);
    expect(verifyToken(t, "unsubscribe", secret)).toBe("contact-123");
  });
  it("rejects tampering, wrong purpose and wrong secret", () => {
    const t = createToken("unsubscribe", "contact-123", secret);
    expect(verifyToken(t, "preferences", secret)).toBeUndefined();
    expect(verifyToken(t, "unsubscribe", "y".repeat(32))).toBeUndefined();
    const forged = createToken("unsubscribe", "contact-999", "z".repeat(32));
    expect(verifyToken(`${t.split(".")[0]}.${forged.split(".")[1]}`, "unsubscribe", secret)).toBeUndefined();
    expect(verifyToken("garbage", "unsubscribe", secret)).toBeUndefined();
  });
  it("refuses short secrets", () => {
    expect(() => createToken("unsubscribe", "c", "short")).toThrow();
  });
});

describe("MemoryProvider", () => {
  it("records sent messages", async () => {
    const p = new MemoryProvider();
    const r = await p.send({
      idempotencyKey: "k",
      to: "reader@example.com",
      from: { address: "letter@example.com" },
      subject: "s",
      html: "<p>h</p>",
      text: "h",
      headers: {},
    });
    expect(r.providerMessageId).toBe("memory-1");
    expect(p.sent).toHaveLength(1);
  });
});

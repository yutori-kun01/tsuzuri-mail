import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hashPassword, totp, verifyPassword, verifyTotp } from "./auth.js";

describe("password hashing", () => {
  it("verifies the right password and rejects others", () => {
    const h = hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery", h)).toBe(true);
    expect(verifyPassword("correct horse batterx", h)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
  it("refuses short passwords", () => {
    expect(() => hashPassword("short")).toThrow();
  });
});

describe("TOTP (RFC 6238 test vectors)", () => {
  // RFC 6238 付録 B の SHA1 用の鍵 "12345678901234567890"（8 桁の値の下 6 桁）
  const key = Buffer.from("12345678901234567890");
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i → %s", (t, code) => {
    expect(totp(key, new Date(t * 1000))).toBe(code);
  });

  it("accepts ±30 seconds of clock drift only", () => {
    const secret = base32Encode(key);
    const now = new Date(1111111109 * 1000);
    expect(verifyTotp(secret, "081804", now)).toBe(true);
    expect(verifyTotp(secret, "081804", new Date(now.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(secret, "081804", new Date(now.getTime() + 120_000))).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
  });

  it("round-trips base32", () => {
    const s = generateTotpSecret();
    expect(base32Encode(base32Decode(s))).toBe(s);
  });
});

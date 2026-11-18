import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, pgConfig } from "../src/db.js";

// テスト専用の自己署名証明書（秘密鍵は破棄済み。どこにも信頼されていない）
const testCa = readFileSync(new URL("./fixtures/test-ca.crt", import.meta.url), "utf8");
const testCaSha256 = new X509Certificate(testCa).fingerprint256;

describe("pgConfig", () => {
  const url = "postgres://user:pw@db.example.com:6543/postgres?sslmode=require";

  it("leaves the connection string alone without a CA", () => {
    expect(pgConfig(url)).toEqual({ max: 3, connectionString: url });
  });

  it("verifies the server certificate against the given CA and drops sslmode", () => {
    const c = pgConfig(url, { ca: testCa, max: 2 });
    expect(c.max).toBe(2);
    expect(c.connectionString).toBe("postgres://user:pw@db.example.com:6543/postgres");
    expect(c.ssl).toEqual({ ca: testCa, rejectUnauthorized: true });
  });

  it("accepts the pinned fingerprint in any notation and rejects a different one", () => {
    expect(() => pgConfig(url, { ca: testCa, caSha256: testCaSha256 })).not.toThrow();
    expect(() => pgConfig(url, { ca: testCa, caSha256: testCaSha256.replace(/:/g, "").toLowerCase() })).not.toThrow();
    expect(() =>
      pgConfig(url, { ca: testCa, caSha256: "807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA" }),
    ).toThrow(/fingerprint/);
  });
});

describe("MIGRATIONS_DIR", () => {
  it("is a real filesystem path (works on Windows too)", () => {
    expect(MIGRATIONS_DIR.startsWith("file:")).toBe(false);
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
  });
});

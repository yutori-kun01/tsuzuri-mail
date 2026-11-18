import { describe, expect, it } from "vitest";
import { allowedSenderDomains, checkSenderOverride, emailDomain, resolveSender, sesDnsRecords } from "./sender.js";

describe("sender domains", () => {
  it("collects the default domain and extra domains without duplicates", () => {
    expect(allowedSenderDomains("info@ml.example.com", ["ML.example.com", "news.other.jp", "bad domain"])).toEqual(["ml.example.com", "news.other.jp"]);
  });
  it("extracts the domain of an address", () => {
    expect(emailDomain("Info@ML.Example.com")).toBe("ml.example.com");
    expect(emailDomain("not-an-address")).toBeUndefined();
  });
});

describe("checkSenderOverride", () => {
  const domains = ["ml.example.com", "news.other.jp"];
  it("accepts blanks (use the global settings) and registered domains", () => {
    expect(checkSenderOverride({}, domains)).toBeUndefined();
    expect(checkSenderOverride({ fromName: "別ブランド", fromAddress: "hello@news.other.jp", replyTo: "me@gmail.com" }, domains)).toBeUndefined();
  });
  it("rejects unregistered domains and header injection", () => {
    expect(checkSenderOverride({ fromAddress: "a@evil.example" }, domains)).toContain("登録されていません");
    expect(checkSenderOverride({ fromName: "a\r\nBcc: x" }, domains)).toBeDefined();
    expect(checkSenderOverride({ replyTo: "nope" }, domains)).toBeDefined();
  });
});

describe("resolveSender", () => {
  const base = { fromName: "つづり通信", fromAddress: "info@ml.example.com", replyTo: "info@example.com" };
  it("keeps the base for blank fields and overrides the rest", () => {
    expect(resolveSender(base, { fromName: " ", fromAddress: "Hello@News.other.jp" })).toEqual({ fromName: "つづり通信", fromAddress: "hello@news.other.jp", replyTo: "info@example.com" });
    expect(resolveSender(base, null)).toEqual(base);
  });
});

describe("sesDnsRecords", () => {
  it("lists DKIM, MAIL FROM, SPF and DMARC records", () => {
    const r = sesDnsRecords("News.Other.jp", ["abc", "def", "ghi"]);
    expect(r.map((x) => `${x.type} ${x.name}`)).toEqual([
      "CNAME abc._domainkey.news.other.jp",
      "CNAME def._domainkey.news.other.jp",
      "CNAME ghi._domainkey.news.other.jp",
      "MX bounce.news.other.jp",
      "TXT bounce.news.other.jp",
      "TXT _dmarc.news.other.jp",
    ]);
    expect(r[0]!.value).toBe("abc.dkim.amazonses.com");
    expect(r[3]!.value).toBe("10 feedback-smtp.ap-northeast-1.amazonses.com");
  });
});

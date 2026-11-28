import { describe, expect, it } from "vitest";
import { decryptTransfer, encryptTransfer, generateTransferKey, parseTransferKey, TransferKeyError } from "./transfer.js";

describe("transfer encryption", () => {
  it("round-trips with the issued key text", () => {
    const { key, text } = generateTransferKey();
    expect(text).toMatch(/^TZK1-[A-Z2-7-]+$/);
    expect(parseTransferKey(`  ${text.toLowerCase().replace("tzk1-", "TZK1-")}`)).toBeDefined();
    const file = encryptTransfer(Buffer.from('{"hello":"読者"}'), key);
    expect(file.includes(Buffer.from("読者"))).toBe(false);
    expect(decryptTransfer(file, parseTransferKey(text)).toString()).toBe('{"hello":"読者"}');
  });

  it("accepts the key without hyphens or with line breaks", () => {
    const { key, text } = generateTransferKey();
    const body = text.slice(5).replace(/-/g, "");
    expect(parseTransferKey(`TZK1-${body.slice(0, 20)}\n${body.slice(20)}`).equals(key)).toBe(true);
  });

  it("detects typos, a wrong key and tampering", () => {
    const { key, text } = generateTransferKey();
    const i = 10;
    const typo = text.slice(0, i) + (text[i] === "A" ? "B" : "A") + text.slice(i + 1);
    expect(() => parseTransferKey(typo)).toThrow(TransferKeyError);
    expect(() => parseTransferKey(text.replace("TZK1-", "TZK1-0"))).toThrow("使えない文字");
    expect(() => parseTransferKey(text.slice(0, 20))).toThrow("長さ");
    const file = encryptTransfer(Buffer.from("data"), key);
    expect(() => decryptTransfer(file, generateTransferKey().key)).toThrow("復号できません");
    const bad = Buffer.from(file);
    bad[20] = bad[20]! ^ 1;
    expect(() => decryptTransfer(bad, key)).toThrow("復号できません");
    expect(() => decryptTransfer(Buffer.from("not a file at all, sorry"), key)).toThrow("引き継ぎファイルではありません");
  });
});

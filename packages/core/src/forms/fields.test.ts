import { describe, expect, it } from "vitest";
import { buildFields, DEFAULT_FIELDS, normalizeFields, parseOptions, validateSubmission, type FieldRowInput } from "./fields.js";

const row = (o: Partial<FieldRowInput>): FieldRowInput => ({ key: "", label: "", type: "text", required: false, enabled: true, extra: "", ...o });

describe("parseOptions", () => {
  it("splits on commas, Japanese commas and newlines, dropping blanks and duplicates", () => {
    expect(parseOptions("SNS, note、AI\nSNS,, ")).toEqual(["SNS", "note", "AI"]);
  });
});

describe("normalizeFields", () => {
  it("falls back to the default name field when nothing is stored", () => {
    expect(normalizeFields(null)).toEqual(DEFAULT_FIELDS);
  });
  it("drops reserved or malformed keys", () => {
    const f = normalizeFields([{ key: "email", label: "x" }, { key: "Bad Key" }, { key: "job", label: "職業", type: "select", options: ["a", "b"] }]);
    expect(f.map((x) => x.key)).toEqual(["job"]);
    expect(f[0]!.options).toEqual(["a", "b"]);
  });
});

describe("buildFields", () => {
  it("ignores empty rows and assigns free keys to new rows", () => {
    const r = buildFields([row({ key: "name", label: "ニックネーム" }), row({ label: "興味", type: "checkbox", extra: "SNS, AI" }), row({}), row({ key: "free1", label: "既存" })]);
    expect("fields" in r && r.fields.map((f) => f.key)).toEqual(["name", "free2", "free1"]);
  });
  it("requires options for choice fields", () => {
    expect(buildFields([row({ label: "興味", type: "radio" })])).toEqual({ error: "「興味」の選択肢を入れてください（カンマ区切り）" });
  });
  it("rejects reserved keys and duplicates", () => {
    expect("error" in buildFields([row({ key: "email", label: "x" })])).toBe(true);
    expect("error" in buildFields([row({ key: "free1", label: "a" }), row({ key: "free1", label: "b" })])).toBe(true);
  });
  it("keeps the name field as text", () => {
    expect("error" in buildFields([row({ key: "name", label: "名前", type: "select", extra: "a" })])).toBe(true);
  });
});

describe("validateSubmission", () => {
  const fields = normalizeFields([
    { key: "name", label: "お名前", type: "text" },
    { key: "job", label: "職業", type: "select", options: ["会社員", "個人事業"], required: true },
    { key: "likes", label: "興味", type: "checkbox", options: ["SNS", "AI", "note"] },
    { key: "src", label: "経路", type: "hidden", defaultValue: "blog" },
    { key: "off", label: "使わない", type: "text", enabled: false },
  ]);

  it("returns the name separately and other values as attributes", () => {
    const r = validateSubmission(fields, { name: " 山田 ", job: "会社員", likes: ["AI", "SNS"], off: "x" });
    expect(r).toEqual({ ok: true, value: { name: "山田", attributes: { job: "会社員", likes: "SNS, AI", src: "blog" } } });
  });
  it("rejects values outside the choices", () => {
    expect(validateSubmission(fields, { job: "社長" }).ok).toBe(false);
    expect(validateSubmission(fields, { job: "会社員", likes: ["SNS", "ゲーム"] }).ok).toBe(false);
  });
  it("enforces required fields", () => {
    expect(validateSubmission(fields, {})).toEqual({ ok: false, error: "「職業」を入力してください" });
  });
  it("strips control characters", () => {
    const r = validateSubmission(fields, { name: "山\u0007田\n", job: "会社員" });
    expect(r.ok && r.value.name).toBe("山 田");
  });
});

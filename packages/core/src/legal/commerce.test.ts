import { describe, expect, it } from "vitest";
import { commerceDisclosureRows, DISCLOSE_ON_REQUEST, missingCommerceFields } from "./commerce.js";

describe("特定商取引法に基づく表記", () => {
  it("必須の項目が空なら知らせる", () => {
    expect(missingCommerceFields(undefined)).toContain("販売業者");
    expect(missingCommerceFields({})).toContain("返品・キャンセル");
  });

  it("所在地・電話番号は「請求があれば開示」にできる", () => {
    const rows = commerceDisclosureRows({ sellerName: "つづり", disclosureOnRequest: true });
    expect(rows).toContainEqual(["所在地", DISCLOSE_ON_REQUEST]);
    expect(rows).toContainEqual(["電話番号", DISCLOSE_ON_REQUEST]);
    expect(missingCommerceFields({ sellerName: "つづり", disclosureOnRequest: true })).not.toContain("所在地");
  });

  it("空の任意項目は出さず、入れたものは出す", () => {
    const keys = commerceDisclosureRows({ sellerName: "つづり" }).map(([k]) => k);
    expect(keys).not.toContain("動作環境");
    expect(commerceDisclosureRows({ environment: "最新のブラウザ" }).map(([k]) => k)).toContain("動作環境");
  });
});

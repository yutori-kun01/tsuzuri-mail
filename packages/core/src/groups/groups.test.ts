import { describe, expect, it } from "vitest";
import { groupItems, moveGroup, normalizeGroupName, type Group } from "./groups.js";

const groups: Group[] = [
  { id: "b", name: "ステップ", position: 2 },
  { id: "a", name: "商品受け渡し", position: 1 },
];

describe("groupItems", () => {
  it("グループなしを先頭に、グループは position 順に並べる", () => {
    const items = [
      { id: "1", group_id: "b" },
      { id: "2", group_id: null },
      { id: "3", group_id: "a" },
      { id: "4", group_id: "b" },
    ];
    const s = groupItems(items, groups);
    expect(s.map((x) => x.group?.id ?? null)).toEqual([null, "a", "b"]);
    expect(s[2]!.items.map((x) => x.id)).toEqual(["1", "4"]);
  });

  it("空のグループも出し、グループなしは中身があるときだけ出す", () => {
    const s = groupItems([{ id: "1", group_id: "a" }], groups);
    expect(s.map((x) => [x.group?.id ?? null, x.items.length])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
  });

  it("存在しないグループを指す項目はグループなしに入れる", () => {
    const s = groupItems([{ id: "1", group_id: "gone" }], []);
    expect(s).toEqual([{ group: null, items: [{ id: "1", group_id: "gone" }] }]);
  });
});

describe("moveGroup", () => {
  it("上下に入れ替える", () => {
    expect(moveGroup(groups, "b", -1)).toEqual(["b", "a"]);
    expect(moveGroup(groups, "a", 1)).toEqual(["b", "a"]);
  });
  it("端や見つからないときは今の並び", () => {
    expect(moveGroup(groups, "a", -1)).toEqual(["a", "b"]);
    expect(moveGroup(groups, "b", 1)).toEqual(["a", "b"]);
    expect(moveGroup(groups, "x", 1)).toEqual(["a", "b"]);
  });
});

describe("normalizeGroupName", () => {
  it("空白を整え、空と長すぎる名前を弾く", () => {
    expect(normalizeGroupName("  商品  受け渡し ")).toBe("商品 受け渡し");
    expect(normalizeGroupName("   ")).toBeNull();
    expect(normalizeGroupName("あ".repeat(41))).toBeNull();
    expect(normalizeGroupName("あ".repeat(40))).toBe("あ".repeat(40));
  });
});

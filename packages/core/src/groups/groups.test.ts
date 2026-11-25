import { describe, expect, it } from "vitest";
import { groupItems, normalizeGroupName, parseLayout, type Group } from "./groups.js";

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

  it("空のグループも、空のグループなしも出す。グループが無ければ空", () => {
    const s = groupItems([{ id: "1", group_id: "a" }], groups);
    expect(s.map((x) => [x.group?.id ?? null, x.items.length])).toEqual([
      [null, 0],
      ["a", 1],
      ["b", 0],
    ]);
    expect(groupItems([{ id: "1", group_id: null }], [])).toEqual([]);
  });

  it("存在しないグループを指す項目はグループなしに入れる", () => {
    const s = groupItems([{ id: "1", group_id: "gone" }], groups);
    expect(s[0]).toEqual({ group: null, items: [{ id: "1", group_id: "gone" }] });
  });
});

describe("parseLayout", () => {
  const known = { groups: new Set(["a", "b"]), items: new Set(["1", "2"]) };
  it("並びと所属を読み取る（空のグループ id はグループなし）", () => {
    expect(parseLayout(["b", "a"], ["2:a", "1:"], known)).toEqual({
      groups: ["b", "a"],
      items: [
        { id: "2", group: "a" },
        { id: "1", group: null },
      ],
    });
  });
  it("知らない id・重複・形の崩れは受け付けない", () => {
    expect(parseLayout(["x"], [], known)).toBeNull();
    expect(parseLayout(["a", "a"], [], known)).toBeNull();
    expect(parseLayout([], ["9:a"], known)).toBeNull();
    expect(parseLayout([], ["1:x"], known)).toBeNull();
    expect(parseLayout([], ["1:a", "1:b"], known)).toBeNull();
    expect(parseLayout([], ["1"], known)).toBeNull();
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

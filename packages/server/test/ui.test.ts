import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missingIcons } from "../src/admin/icons.js";
import { delta, donut, lineChart, ring, sparkline } from "../src/admin/ui.js";

describe("admin UI kit", () => {
  it("型に挙げたアイコンがすべて lucide に実在する", () => {
    const src = readFileSync(new URL("../src/admin/icons.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("export type IconName"), src.indexOf("export function icon"));
    const names = [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    expect(missingIcons(names)).toEqual([]);
  });

  it("グラフは値が全部 0 でも壊れない", () => {
    expect(sparkline([0, 0, 0])).toContain("<svg");
    for (const svg of [
      lineChart({ series: [[0, 0], [0, 0]], labels: ["1/1", "1/2"], names: ["送信", "新規登録"] }),
      lineChart({ series: [[3], [1]], labels: ["1/1"], names: ["送信", "新規登録"] }),
      donut({ items: [{ label: "熱心", value: 0, color: "--chart-1" }], center: "0", sub: "人" }),
      ring(0, 5),
    ]) {
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("Infinity");
    }
  });

  it("前の期間との差は、前の期間が 0 なら比べない", () => {
    expect(delta(12, 0)).toBeNull();
    expect(delta(110, 100)).toBeCloseTo(10);
  });
});

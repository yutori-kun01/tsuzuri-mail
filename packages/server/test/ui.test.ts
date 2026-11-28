import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { HTMX_SOURCE } from "../src/admin/generated/htmx.js";
import { ICON_NODES } from "../src/admin/generated/icon-nodes.js";
import { missingIcons } from "../src/admin/icons.js";

const require = createRequire(import.meta.url);
import { delta, donut, lineChart, ring, sparkline } from "../src/admin/ui.js";

describe("admin UI kit", () => {
  it("型に挙げたアイコンがすべて lucide に実在する", () => {
    const src = readFileSync(new URL("../src/admin/icons.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("export type IconName"), src.indexOf("export function icon"));
    const names = [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    expect(missingIcons(names)).toEqual([]);
    // 書き出したアイコン（generated/icon-nodes.ts）が lucide-static と一致する（ずれていたら pnpm gen:assets）
    const all = JSON.parse(readFileSync(require.resolve("lucide-static/icon-nodes.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(ICON_NODES).sort()).toEqual([...new Set(names)].sort());
    for (const n of names) expect(ICON_NODES[n]).toEqual(all[n]);
  });

  it("書き出した htmx が node_modules の版と一致する（ずれていたら pnpm gen:assets）", () => {
    expect(HTMX_SOURCE).toBe(readFileSync(require.resolve("htmx.org/dist/htmx.min.js"), "utf8"));
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

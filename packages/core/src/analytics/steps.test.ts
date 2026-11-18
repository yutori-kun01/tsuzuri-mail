import { describe, expect, it } from "vitest";
import { stepFlags } from "./steps.js";

describe("stepFlags", () => {
  it("flags low click rates, unsubscribes and big drops", () => {
    const f = stepFlags([
      { id: "a", sent: 100, clicked: 30, unsubscribed: 0 },
      { id: "b", sent: 180, clicked: 40, unsubscribed: 1 },
      { id: "c", sent: 50, clicked: 2, unsubscribed: 1 },
    ]);
    expect(f.get("a")).toEqual([]);
    expect(f.get("b")).toEqual(["unsub-warn"]);
    expect(f.get("c")).toEqual(["low-click", "unsub-bad", "big-drop"]);
  });
  it("does not flag steps with nothing sent", () => {
    expect(stepFlags([{ id: "a", sent: 0, clicked: 0, unsubscribed: 0 }]).get("a")).toEqual([]);
  });
});

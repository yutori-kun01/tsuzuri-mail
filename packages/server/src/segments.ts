import type { Tier } from "@tsuzuri/core";

/**
 * セグメント（抽出条件）。管理画面のクエリビルダーがこの形の JSON を作る。
 * contacts の別名 c に対する WHERE 句へ変換する。値はすべてパラメータで渡す。
 */
export type SegmentRule =
  | { type: "group"; op: "and" | "or"; rules: SegmentRule[]; not?: boolean }
  | { type: "tag"; tag: string; has: boolean }
  | { type: "score"; op: ">=" | "<=" | ">" | "<"; value: number }
  | { type: "tier"; in: Tier[] }
  | { type: "source"; in: string[] }
  | { type: "subscribedWithinDays"; days: number }
  | { type: "attr"; key: string; equals: string };

const SCORE_OPS = new Set([">=", "<=", ">", "<"]);

export class SegmentError extends Error {}

/** params に値を積み、SQL 断片を返す。 */
export function compileSegment(rule: SegmentRule, params: unknown[]): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (rule.type) {
    case "group": {
      if (rule.op !== "and" && rule.op !== "or") throw new SegmentError("bad group op");
      const parts = rule.rules.map((r) => `(${compileSegment(r, params)})`);
      const body = parts.length === 0 ? "TRUE" : parts.join(rule.op === "and" ? " AND " : " OR ");
      return rule.not ? `NOT (${body})` : body;
    }
    case "tag": {
      const exists = `EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.name = ${p(rule.tag)})`;
      return rule.has ? exists : `NOT ${exists}`;
    }
    case "score":
      if (!SCORE_OPS.has(rule.op) || !Number.isFinite(rule.value)) throw new SegmentError("bad score rule");
      return `c.score ${rule.op} ${p(rule.value)}`;
    case "tier":
      return `c.tier = ANY(${p(rule.in)}::text[])`;
    case "source":
      return `c.source = ANY(${p(rule.in)}::text[])`;
    case "subscribedWithinDays":
      if (!Number.isInteger(rule.days) || rule.days < 0) throw new SegmentError("bad days");
      return `c.created_at >= now() - (${p(rule.days)}::int * interval '1 day')`;
    case "attr":
      return `c.attributes ->> ${p(rule.key)} = ${p(rule.equals)}`;
    default:
      throw new SegmentError("unknown rule");
  }
}

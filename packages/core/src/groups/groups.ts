/**
 * 一覧のグループ分け（シナリオ・フォーム）。表示の整理だけで、配信の動きには関わらない。
 */

export const GROUP_KINDS = ["sequence", "form"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const GROUP_NAME_MAX = 40;

export interface Group {
  id: string;
  name: string;
  position: number;
}

export interface GroupSection<T> {
  /** null は「グループなし」 */
  group: Group | null;
  items: T[];
}

/** グループ名を整える。空や長すぎる名前は null */
export function normalizeGroupName(v: string): string | null {
  const name = v.replace(/\s+/g, " ").trim();
  if (!name || [...name].length > GROUP_NAME_MAX) return null;
  return name;
}

/**
 * 項目をグループごとにまとめる。「グループなし」は先頭、グループは position→名前の順。
 * 空のグループも「グループなし」も出す（ドラッグで入れられる場所として見せるため）。グループが無ければ空配列。
 * 存在しないグループを指す項目は「グループなし」に入れる。項目の並びは渡された順を保つ。
 */
export function groupItems<T extends { group_id: string | null }>(items: readonly T[], groups: readonly Group[]): GroupSection<T>[] {
  if (!groups.length) return [];
  const sorted = [...groups].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, "ja"));
  const byId = new Map<string, T[]>(sorted.map((g) => [g.id, []]));
  const none: T[] = [];
  for (const it of items) {
    const bucket = it.group_id ? byId.get(it.group_id) : undefined;
    (bucket ?? none).push(it);
  }
  return [{ group: null, items: none }, ...sorted.map((g) => ({ group: g, items: byId.get(g.id)! }))];
}

/** ドラッグで並べ替えた結果。groups はグループの並び、items は項目の並びと入るグループ（null はグループなし） */
export interface Layout {
  groups: string[];
  items: { id: string; group: string | null }[];
}

/**
 * 画面から送られた並び（groups：グループ id、items：「項目 id:グループ id」）を確かめて Layout にする。
 * 知らない id・重複・形の崩れがあれば null（一部だけ保存して並びが壊れるのを防ぐ）。
 */
export function parseLayout(groups: readonly string[], items: readonly string[], known: { groups: ReadonlySet<string>; items: ReadonlySet<string> }): Layout | null {
  if (new Set(groups).size !== groups.length || groups.some((g) => !known.groups.has(g))) return null;
  const out: Layout["items"] = [];
  const seen = new Set<string>();
  for (const v of items) {
    const i = v.indexOf(":");
    if (i < 0) return null;
    const id = v.slice(0, i);
    const group = v.slice(i + 1) || null;
    if (!known.items.has(id) || seen.has(id) || (group !== null && !known.groups.has(group))) return null;
    seen.add(id);
    out.push({ id, group });
  }
  return { groups: [...groups], items: out };
}

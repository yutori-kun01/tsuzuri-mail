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
 * 項目をグループごとにまとめる。グループは position→名前の順、「グループなし」は先頭。
 * 中身が空のグループも出す（作ったばかりのグループを見せるため）。「グループなし」は中身があるときだけ出す。
 * 存在しないグループを指す項目は「グループなし」に入れる。項目の並びは渡された順を保つ。
 */
export function groupItems<T extends { group_id: string | null }>(items: readonly T[], groups: readonly Group[]): GroupSection<T>[] {
  const sorted = [...groups].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, "ja"));
  const byId = new Map<string, T[]>(sorted.map((g) => [g.id, []]));
  const none: T[] = [];
  for (const it of items) {
    const bucket = it.group_id ? byId.get(it.group_id) : undefined;
    (bucket ?? none).push(it);
  }
  const sections: GroupSection<T>[] = sorted.map((g) => ({ group: g, items: byId.get(g.id)! }));
  return none.length ? [{ group: null, items: none }, ...sections] : sections;
}

/**
 * グループを 1 つ上（-1）または下（+1）へ動かした後の並び（id の配列）。
 * 端で動かそうとしたとき、見つからないときは、今の並びをそのまま返す。
 */
export function moveGroup(groups: readonly Group[], id: string, dir: -1 | 1): string[] {
  const ids = [...groups].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, "ja")).map((g) => g.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return ids;
}

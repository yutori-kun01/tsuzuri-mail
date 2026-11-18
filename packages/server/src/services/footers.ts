import type { Db } from "../db.js";

export interface Footer {
  id: string;
  name: string;
  body: string;
  is_default: boolean;
}

export async function listFooters(db: Db): Promise<Footer[]> {
  return db.query<Footer>("SELECT id, name, body, is_default FROM footers ORDER BY is_default DESC, created_at");
}

/**
 * 使うフッターの本文。指定（一斉配信・シナリオの footer_id）が無ければ既定のフッター。
 * どちらも無ければ undefined（標準の組み込みフッターを使う）。
 */
export async function footerBody(db: Db, footerId: string | null | undefined): Promise<string | undefined> {
  const [f] = await db.query<{ body: string }>(
    "SELECT body FROM footers WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR ($1::uuid IS NULL AND is_default) ORDER BY is_default LIMIT 1",
    [footerId ?? null],
  );
  if (f) return f.body;
  if (footerId) return footerBody(db, null); // 指定が消えていたら既定へ
  return undefined;
}

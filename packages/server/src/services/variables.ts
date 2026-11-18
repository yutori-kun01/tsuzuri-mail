import { validateCustomKey, type CustomVariable, type PlaceholderKind } from "@tsuzuri/core";
import type { Db } from "../db.js";

export async function listCustomVariables(db: Db): Promise<CustomVariable[]> {
  return db.query<CustomVariable>("SELECT key, value, kind FROM custom_variables ORDER BY key");
}

export async function customVariableKeys(db: Db): Promise<string[]> {
  return (await db.query<{ key: string }>("SELECT key FROM custom_variables")).map((r) => r.key);
}

/** 独自の置き換え文字を登録・更新する。名前が不正なら理由を返す。 */
export async function setCustomVariable(
  db: Db,
  key: string,
  value: string,
  kind: PlaceholderKind = "text",
  note?: string,
): Promise<string | undefined> {
  const problem = validateCustomKey(key);
  if (problem) return problem;
  if (kind === "url" && !/^https?:\/\//.test(value)) return "URL 型の値は http(s):// で始めてください";
  await db.query(
    `INSERT INTO custom_variables (key, value, kind, note, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, kind = EXCLUDED.kind, note = EXCLUDED.note, updated_at = now()`,
    [key, value, kind, note ?? null],
  );
  return undefined;
}

export async function deleteCustomVariable(db: Db, key: string): Promise<void> {
  await db.query("DELETE FROM custom_variables WHERE key = $1", [key]);
}

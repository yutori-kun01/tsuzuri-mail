import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

/**
 * マイグレーション（手元の CLI と VPS 版からだけ使う。Workers には載せない：ファイルを読むため）。
 * Cloudflare 版では、手元から `pnpm tsuzuri migrate` を Supabase に向けて実行する。
 */
// fileURLToPath を使う（Windows のドライブ名や日本語などを含むパスを正しく扱うため）
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** 未適用のマイグレーションを名前順に適用する。 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR, exec?: (sql: string) => Promise<void>): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    if (exec) {
      // PGlite など：複数文は exec で流す（exec 側の都合でトランザクションは張らない）
      await exec(sql);
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    } else {
      // pg：パラメータなしのクエリは複数文をそのまま流せる
      await db.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      });
    }
    done.push(f);
  }
  return done;
}

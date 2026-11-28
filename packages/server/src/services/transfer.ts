import { createHmac } from "node:crypto";
import { decryptTransfer, encryptTransfer, generateTransferKey, parseTransferKey } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";

/**
 * データの引き継ぎ（別のサーバー・別の DB への引っ越し）。
 *
 * 書き出し：アプリの表をすべて JSON にまとめ、毎回新しく作る暗号化キーで暗号化する。キーは画面に 1 回だけ出す。
 * 読み込み：ファイルとキーを受け取り、復号できたら、今のデータを**すべて置き換える**（1 つのトランザクションの中で行い、
 *           途中で失敗したら何も変わらない）。置き換えたあとはそのまま使える。
 *
 * 書き出さないもの：マイグレーションの記録（その DB のもの）、ログインの失敗記録、パスキーのチャレンジ、一時ファイル。
 * 環境変数にあるもの（TOKEN_SECRET、管理者のパスワード・認証アプリ、AWS の鍵、DB の接続先）はファイルに入らない。
 * 送ったメールの配信停止リンクなどを使い続けるには、新しい環境の TOKEN_SECRET を元と同じにする（読み込み時に確かめて知らせる）。
 */

export const TRANSFER_FORMAT = "tsuzuri-mail-transfer";
export const TRANSFER_VERSION = 1;
const SKIP_TABLES = new Set(["schema_migrations", "admin_login_failures", "admin_webauthn_challenges", "data_exports"]);
/** 量が多くなりやすい履歴（書き出しで外せる） */
export const HISTORY_TABLES = ["events", "messages", "score_history", "admin_audit", "automation_runs"] as const;
const EXPORT_HOURS = 1;
const BATCH = 500;

export interface TransferPayload {
  format: string;
  version: number;
  exportedAt: string;
  migrations: string[];
  /** TOKEN_SECRET が同じかを確かめるための指紋（秘密そのものではない） */
  secretFingerprint: string;
  tables: Record<string, { columns: string[]; rows: Record<string, unknown>[] }>;
}

export function secretFingerprint(secret: string): string {
  return createHmac("sha256", secret).update("tsuzuri-transfer-fingerprint").digest("hex").slice(0, 16);
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** 引き継ぎの対象にする表を、外部キーの親が先に来る順に並べる */
export async function transferTables(db: Db): Promise<string[]> {
  const tables = (
    await db.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
  )
    .map((r) => r.name)
    .filter((t) => !SKIP_TABLES.has(t));
  const fks = await db.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND n.nspname = current_schema()`,
  );
  const set = new Set(tables);
  const ordered: string[] = [];
  const done = new Set<string>();
  const visit = (t: string, path: Set<string>) => {
    if (done.has(t) || path.has(t)) return;
    path.add(t);
    for (const f of fks) if (f.child === t && f.parent !== t && set.has(f.parent)) visit(f.parent, path);
    path.delete(t);
    done.add(t);
    ordered.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return ordered;
}

async function columnsOf(db: Db, table: string): Promise<{ name: string; identity: boolean }[]> {
  return db.query<{ name: string; identity: boolean }>(
    `SELECT column_name AS name, (is_identity = 'YES') AS identity FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
}

export async function buildPayload(ctx: AppContext, o: { includeHistory: boolean }): Promise<TransferPayload> {
  const tables: TransferPayload["tables"] = {};
  for (const t of await transferTables(ctx.db)) {
    if (!o.includeHistory && (HISTORY_TABLES as readonly string[]).includes(t)) continue;
    const cols = (await columnsOf(ctx.db, t)).map((c) => c.name);
    // 型の表し方を PostgreSQL にそろえてもらう（日時・数値・配列・JSON をそのまま戻せる形）
    const [r] = await ctx.db.query<{ j: string }>(`SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text AS j FROM ${q(t)} x`);
    tables[t] = { columns: cols, rows: JSON.parse(r?.j ?? "[]") as Record<string, unknown>[] };
  }
  const migrations = (await ctx.db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).map((r) => r.name);
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: ctx.now().toISOString(),
    migrations,
    secretFingerprint: secretFingerprint(ctx.secret),
    tables,
  };
}

export interface ExportResult {
  id: string;
  keyText: string;
  bytes: number;
  counts: Record<string, number>;
}

/** 書き出して暗号化し、1 時間だけダウンロードできるように置く。キーは戻り値でだけ返す */
export async function createExport(ctx: AppContext, o: { includeHistory: boolean }): Promise<ExportResult> {
  const payload = await buildPayload(ctx, o);
  const { key, text } = generateTransferKey();
  const file = encryptTransfer(Buffer.from(JSON.stringify(payload)), key);
  const counts = Object.fromEntries(Object.entries(payload.tables).map(([t, v]) => [t, v.rows.length]));
  const now = ctx.now();
  await ctx.db.query("DELETE FROM data_exports WHERE expires_at <= $1", [now]);
  const [row] = await ctx.db.query<{ id: string }>("INSERT INTO data_exports (file, summary, expires_at) VALUES ($1, $2, $3) RETURNING id", [
    file,
    JSON.stringify({ counts, includeHistory: o.includeHistory, bytes: file.length }),
    new Date(now.getTime() + EXPORT_HOURS * 3_600_000),
  ]);
  return { id: row!.id, keyText: text, bytes: file.length, counts };
}

export async function readExport(ctx: AppContext, id: string): Promise<{ file: Buffer; created_at: Date } | undefined> {
  const [r] = await ctx.db.query<{ file: Uint8Array; created_at: Date }>(
    "SELECT file, created_at FROM data_exports WHERE id::text = $1 AND expires_at > $2",
    [id, ctx.now()],
  );
  return r ? { file: Buffer.from(r.file), created_at: r.created_at } : undefined;
}

export class TransferError extends Error {}

/** ファイルとキーから中身を取り出し、この環境に読み込めるかを確かめる（まだ何も変えない） */
export async function openTransfer(ctx: AppContext, file: Buffer, keyText: string): Promise<{ payload: TransferPayload; sameSecret: boolean; counts: Record<string, number> }> {
  const key = parseTransferKey(keyText);
  let payload: TransferPayload;
  try {
    payload = JSON.parse(decryptTransfer(file, key).toString("utf8")) as TransferPayload;
  } catch (e) {
    if (e instanceof SyntaxError) throw new TransferError("ファイルの中身を読めませんでした");
    throw e;
  }
  if (payload.format !== TRANSFER_FORMAT || payload.version !== TRANSFER_VERSION || typeof payload.tables !== "object") {
    throw new TransferError("tsuzuri-mail の引き継ぎファイルではないか、対応していない版です");
  }
  const here = new Set((await ctx.db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const newer = (payload.migrations ?? []).filter((m) => !here.has(m));
  if (newer.length) {
    throw new TransferError(`書き出した環境の方が新しい版です。この環境の tsuzuri-mail を更新してから読み込んでください（足りない更新：${newer.join(", ")}）`);
  }
  const counts = Object.fromEntries(Object.entries(payload.tables).map(([t, v]) => [t, Array.isArray(v?.rows) ? v.rows.length : 0]));
  return { payload, sameSecret: payload.secretFingerprint === secretFingerprint(ctx.secret), counts };
}

/** 今のデータをすべて消して、ファイルの中身に置き換える（1 つのトランザクション） */
export async function applyTransfer(ctx: AppContext, payload: TransferPayload): Promise<Record<string, number>> {
  const tables = await transferTables(ctx.db);
  const imported: Record<string, number> = {};
  await ctx.db.transaction(async (tx) => {
    await tx.query(`TRUNCATE ${tables.map(q).join(", ")} RESTART IDENTITY CASCADE`);
    for (const t of tables) {
      const src = payload.tables[t];
      if (!src || !Array.isArray(src.rows) || src.rows.length === 0) continue;
      const cols = await columnsOf(tx, t);
      // 元にもこの環境にもある列だけを入れる（この環境で増えた列は既定値になる）
      const use = cols.filter((c) => src.columns.includes(c.name));
      if (use.length === 0) continue;
      const list = use.map((c) => q(c.name)).join(", ");
      const override = use.some((c) => c.identity) ? " OVERRIDING SYSTEM VALUE" : "";
      for (let i = 0; i < src.rows.length; i += BATCH) {
        await tx.query(`INSERT INTO ${q(t)} (${list})${override} SELECT ${list} FROM jsonb_populate_recordset(NULL::${q(t)}, $1::jsonb)`, [
          JSON.stringify(src.rows.slice(i, i + BATCH)),
        ]);
      }
      // 自動採番の続きを合わせる
      for (const c of use.filter((x) => x.identity)) {
        await tx.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT max(${q(c.name)}) FROM ${q(t)}), 0), 1), (SELECT count(*) FROM ${q(t)}) > 0)`,
          [t, c.name],
        );
      }
      imported[t] = src.rows.length;
    }
  });
  return imported;
}

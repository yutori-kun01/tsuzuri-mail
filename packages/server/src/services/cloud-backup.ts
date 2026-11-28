import { decryptTransfer, encryptTransfer } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import type { R2BucketLike } from "../providers/r2.js";
import { columnsOf, secretFingerprint, TRANSFER_FORMAT, TRANSFER_VERSION, transferTables, type TransferPayload } from "./transfer.js";

/**
 * 毎晩のバックアップ（Supabase → Cloudflare R2）。
 *
 * - 全部の表（送信記録・行動履歴を含む）を、表ごと・CHUNK_ROWS 行ごとに分けて、それぞれ暗号化して置く。
 *   Workers のメモリは 128MB なので、全部を 1 つにまとめない（読者 5,000 人・行動履歴 30 万件で JSON は 140MB ほどになる）。
 * - 1 つの読み取り専用トランザクション（REPEATABLE READ）の中でカーソルを使って読むので、表どうしの中身はそろう。
 * - 暗号化は「データの引き継ぎ」と同じ（AES-256-GCM。鍵は BACKUP_ENCRYPTION_KEY。Worker の secret にだけ置く）。
 * - 置き場所：backups/<日付>/<表>.<連番>.tzx と、最後に backups/<日付>/manifest.tzx（これがあれば完了している）。
 * - 復元：管理画面の「バックアップ」でその日の分を 1 つのファイル（.tzb）にまとめてダウンロードし、
 *   手元で `BACKUP_ENCRYPTION_KEY=… pnpm tsuzuri backup:restore <file.tzb> --yes`。
 */
export const BACKUP_PREFIX = "backups/";
export const BACKUP_FORMAT = "tsuzuri-mail-backup";
export const BACKUP_VERSION = 1;
export const CHUNK_ROWS = 5000;

export interface BackupManifest {
  format: string;
  version: number;
  exportedAt: string;
  migrations: string[];
  secretFingerprint: string;
  tables: Record<string, { columns: string[]; rows: number; parts: string[] }>;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function backupDay(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export async function backupToR2(
  ctx: AppContext,
  bucket: R2BucketLike,
  key: Buffer,
  day: string,
  chunkRows = CHUNK_ROWS,
): Promise<{ manifest: string; bytes: number; rows: number; parts: number }> {
  const dir = `${BACKUP_PREFIX}${day}/`;
  // 同じ日に取り直すときは、前の分を消してから書く
  await deletePrefix(bucket, dir);
  let bytes = 0;
  let rows = 0;
  let partsCount = 0;
  const manifest = await ctx.db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const tables: BackupManifest["tables"] = {};
    for (const t of await transferTables(tx)) {
      const columns = (await columnsOf(tx, t)).map((c) => c.name);
      const parts: string[] = [];
      let n = 0;
      await tx.query(`DECLARE tz_backup NO SCROLL CURSOR FOR SELECT to_jsonb(x)::text AS j FROM ${q(t)} x`);
      for (;;) {
        const batch = await tx.query<{ j: string }>(`FETCH ${chunkRows} FROM tz_backup`);
        if (batch.length === 0) break;
        const name = `${dir}${t}.${String(parts.length + 1).padStart(4, "0")}.tzx`;
        // 行は JSON の文字列のまま並べる（PostgreSQL の表し方のまま戻せる形）
        const file = encryptTransfer(Buffer.from(`{"table":${JSON.stringify(t)},"rows":[${batch.map((r) => r.j).join(",")}]}`), key);
        await bucket.put(name, file);
        parts.push(name);
        bytes += file.length;
        n += batch.length;
        if (batch.length < chunkRows) break;
      }
      await tx.query("CLOSE tz_backup");
      tables[t] = { columns, rows: n, parts };
      rows += n;
      partsCount += parts.length;
    }
    const migrations = (await tx.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).map((r) => r.name);
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: ctx.now().toISOString(),
      migrations,
      secretFingerprint: secretFingerprint(ctx.secret),
      tables,
    } satisfies BackupManifest;
  });
  const m = encryptTransfer(Buffer.from(JSON.stringify(manifest)), key);
  await bucket.put(`${dir}manifest.tzx`, m);
  return { manifest: `${dir}manifest.tzx`, bytes: bytes + m.length, rows, parts: partsCount };
}

async function listAll(bucket: R2BucketLike, prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const r = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const o of r.objects) out.push({ key: o.key, size: o.size });
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}

async function deletePrefix(bucket: R2BucketLike, prefix: string): Promise<number> {
  const keys = (await listAll(bucket, prefix)).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
  return keys.length;
}

export interface BackupDayInfo {
  day: string;
  bytes: number;
  files: number;
  /** manifest がある（最後まで書けた） */
  complete: boolean;
}

/** 保存しているバックアップ（日ごと）。容量の見積もりにも使う */
export async function listBackups(bucket: R2BucketLike): Promise<BackupDayInfo[]> {
  const days = new Map<string, BackupDayInfo>();
  for (const o of await listAll(bucket, BACKUP_PREFIX)) {
    const day = o.key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const d = days.get(day) ?? { day, bytes: 0, files: 0, complete: false };
    d.bytes += o.size;
    d.files += 1;
    if (o.key.endsWith("/manifest.tzx")) d.complete = true;
    days.set(day, d);
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** 保存期間を過ぎたバックアップを消す。消した日数を返す */
export async function pruneR2Backups(bucket: R2BucketLike, keepDays: number, now: Date): Promise<number> {
  const edge = backupDay(new Date(now.getTime() - keepDays * 86_400_000));
  let removed = 0;
  for (const d of await listBackups(bucket)) {
    if (d.day < edge) {
      await deletePrefix(bucket, `${BACKUP_PREFIX}${d.day}/`);
      removed++;
    }
  }
  return removed;
}

/**
 * その日のバックアップを 1 つのファイル（.tzb）にまとめて流す（メモリにためない）。
 * 形式：先頭 4 バイト "TZB1"、続けて [名前の長さ 2 バイト][名前][中身の長さ 4 バイト][中身] の繰り返し。中身は暗号化したまま。
 */
export const BUNDLE_MAGIC = "TZB1";

export async function bundleStream(bucket: R2BucketLike, day: string): Promise<ReadableStream<Uint8Array> | undefined> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const objects = await listAll(bucket, `${BACKUP_PREFIX}${day}/`);
  if (!objects.some((o) => o.key.endsWith("/manifest.tzx"))) return undefined;
  // manifest を先頭に
  objects.sort((a, b) => (a.key.endsWith("/manifest.tzx") ? -1 : b.key.endsWith("/manifest.tzx") ? 1 : a.key < b.key ? -1 : 1));
  let i = -1;
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i === -1) {
        controller.enqueue(enc.encode(BUNDLE_MAGIC));
        i = 0;
        return;
      }
      const o = objects[i++];
      if (!o) return controller.close();
      const obj = await bucket.get(o.key);
      if (!obj) return controller.error(new Error(`missing ${o.key}`));
      const data = new Uint8Array(await new Response(obj.body).arrayBuffer());
      const name = enc.encode(o.key.slice(o.key.lastIndexOf("/") + 1));
      const head = new Uint8Array(2 + name.length + 4);
      const view = new DataView(head.buffer);
      view.setUint16(0, name.length);
      head.set(name, 2);
      view.setUint32(2 + name.length, data.length);
      controller.enqueue(head);
      controller.enqueue(data);
    },
  });
}

/** .tzb を読み、暗号を解いて「データの引き継ぎ」と同じ形にする（手元の CLI で使う。メモリは手元のもの） */
export function readBundle(file: Buffer, key: Buffer): TransferPayload {
  if (file.subarray(0, 4).toString("latin1") !== BUNDLE_MAGIC) throw new Error("tsuzuri-mail のバックアップ（.tzb）ではありません");
  const files = new Map<string, Buffer>();
  let p = 4;
  while (p < file.length) {
    const nameLen = file.readUInt16BE(p);
    const name = file.subarray(p + 2, p + 2 + nameLen).toString("utf8");
    const len = file.readUInt32BE(p + 2 + nameLen);
    const start = p + 2 + nameLen + 4;
    files.set(name, file.subarray(start, start + len));
    p = start + len;
  }
  const mf = files.get("manifest.tzx");
  if (!mf) throw new Error("manifest がありません（途中までのバックアップです）");
  const manifest = JSON.parse(decryptTransfer(mf, key).toString("utf8")) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) throw new Error("対応していない版のバックアップです");
  const tables: TransferPayload["tables"] = {};
  for (const [t, info] of Object.entries(manifest.tables)) {
    const rows: Record<string, unknown>[] = [];
    for (const part of info.parts) {
      const name = part.slice(part.lastIndexOf("/") + 1);
      const buf = files.get(name);
      if (!buf) throw new Error(`バックアップの一部（${name}）がありません`);
      const chunk = JSON.parse(decryptTransfer(buf, key).toString("utf8")) as { table: string; rows: Record<string, unknown>[] };
      if (chunk.table !== t) throw new Error(`バックアップの一部（${name}）の中身が違います`);
      for (const r of chunk.rows) rows.push(r);
    }
    if (rows.length !== info.rows) throw new Error(`表 ${t} の行数が合いません`);
    tables[t] = { columns: info.columns, rows };
  }
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: manifest.exportedAt,
    migrations: manifest.migrations,
    secretFingerprint: manifest.secretFingerprint,
    tables,
  };
}

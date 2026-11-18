import type { Db } from "../db.js";

/**
 * 毎晩の書き出し（データベース側のバックアップに頼らないための保険）。
 * 読者・同意・タグ・シナリオなど「失うと困る」表を NDJSON で書き出す。
 * 行動履歴（events）と送信記録（messages）は量が多く再生成もできないが、スコアの元データなので直近分だけ含める。
 */
export const BACKUP_TABLES = [
  "contacts",
  "channels",
  "consents",
  "tags",
  "contact_tags",
  "segments",
  "sequences",
  "sequence_steps",
  "forms",
  "enrollments",
  "broadcasts",
  "custom_variables",
  "app_settings",
  "score_settings",
] as const;

const RECENT_DAYS = 90;

export interface BackupWriter {
  write(name: string, ndjson: string): Promise<void>;
}

export async function exportAll(db: Db, writer: BackupWriter, now: Date): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
  const queries: [string, string, unknown[]][] = [
    ...BACKUP_TABLES.map((t): [string, string, unknown[]] => [t, `SELECT * FROM ${t}`, []]),
    ["messages_recent", "SELECT * FROM messages WHERE queued_at >= $1", [since]],
    ["events_recent", "SELECT * FROM events WHERE occurred_at >= $1", [since]],
  ];
  for (const [name, sql, params] of queries) {
    const rows = await db.query(sql, params);
    counts[name] = rows.length;
    await writer.write(name, rows.map((r) => JSON.stringify(r)).join("\n"));
  }
  return counts;
}

/** 古い行動履歴を消す（スコアは 180 日分しか使わないため、400 日より前は不要） */
export async function pruneOldData(db: Db, now: Date, keepDays = 400): Promise<{ events: number; scoreHistory: number }> {
  const edge = new Date(now.getTime() - keepDays * 86_400_000);
  const ev = await db.query<{ n: number }>(
    "WITH d AS (DELETE FROM events WHERE occurred_at < $1 RETURNING 1) SELECT count(*)::int AS n FROM d",
    [edge],
  );
  const sh = await db.query<{ n: number }>(
    "WITH d AS (DELETE FROM score_history WHERE day < $1::date RETURNING 1) SELECT count(*)::int AS n FROM d",
    [edge.toISOString().slice(0, 10)],
  );
  return { events: ev[0]?.n ?? 0, scoreHistory: sh[0]?.n ?? 0 };
}

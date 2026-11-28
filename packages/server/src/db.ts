import { X509Certificate } from "node:crypto";
import pg from "pg";

/** DB への最小限のインターフェース。本番は pg、テストは PGlite で実装する。 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** 渡した関数をトランザクション内で実行する。入れ子の呼び出しは外側のトランザクションに合流する。 */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export interface PgOptions {
  max?: number;
  /** サーバー証明書を検証する CA（PEM）。Supabase のように独自の CA を使うサービス向け */
  ca?: string;
  /** CA の SHA-256 指紋（例 80:70:25:...）。指定すると、違う CA が渡されたときに接続しない */
  caSha256?: string;
}

/** 指紋の表記ゆれ（コロンの有無、大文字小文字）をそろえる */
function normalizeFingerprint(f: string): string {
  return f.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

/**
 * pg の接続設定を作る。CA を渡した場合は、接続文字列の sslmode などを取り除き、
 * 「証明書とホスト名を必ず検証する」設定を明示する（検証を無効にする設定は使わない）。
 */
export function pgConfig(connectionString: string, opts: PgOptions = {}): pg.PoolConfig {
  const base: pg.PoolConfig = { max: opts.max ?? 3 };
  if (!opts.ca) return { ...base, connectionString };
  if (opts.caSha256) {
    const actual = new X509Certificate(opts.ca).fingerprint256;
    if (normalizeFingerprint(actual) !== normalizeFingerprint(opts.caSha256)) {
      throw new Error("database CA fingerprint does not match DATABASE_CA_SHA256");
    }
  }
  const u = new URL(connectionString);
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) u.searchParams.delete(k);
  return { ...base, connectionString: u.toString(), ssl: { ca: opts.ca, rejectUnauthorized: true } };
}

export function pgDb(connectionString: string, opts: PgOptions = {}): Db & { end(): Promise<void> } {
  const pool = new pg.Pool(pgConfig(connectionString, opts));
  const onClient = (client: pg.PoolClient): Db => ({
    async query(sql, params) {
      return (await client.query(sql, params as unknown[])).rows;
    },
    transaction: (fn) => fn(onClient(client)),
  });
  return {
    async query(sql, params) {
      return (await pool.query(sql, params as unknown[])).rows;
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(onClient(client));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

import { PGlite } from "@electric-sql/pglite";
import { MemoryProvider } from "@tsuzuri/core";
import type { AppContext } from "../src/context.js";
import type { Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

export function pgliteDb(pg: PGlite): Db {
  const wrap = (q: Pick<PGlite, "query">): Db => ({
    async query(sql, params) {
      return (await q.query(sql, params as unknown[])).rows as never[];
    },
    transaction: (fn) => fn(wrap(q)),
  });
  return {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx as unknown as Pick<PGlite, "query">))),
  };
}

export interface TestEnv {
  ctx: AppContext;
  provider: MemoryProvider;
  setNow(d: Date): void;
  advanceDays(n: number): void;
}

export async function createEnv(start = new Date("2026-11-13T00:00:00Z")): Promise<TestEnv> {
  const pg = new PGlite();
  const db = pgliteDb(pg);
  await migrate(db, undefined, async (sql) => {
    await pg.exec(sql);
  });
  const provider = new MemoryProvider();
  let now = start;
  const ctx: AppContext = {
    db,
    provider,
    publicBaseUrl: "https://mail.example.com",
    secret: "s".repeat(40),
    settings: {
      fromAddress: "info@ml.example.com",
      fromName: "つづり通信",
      senderName: "つづり通信",
      senderAddress: "東京都千代田区1-1-1",
      contact: "https://example.com/contact",
      defaultName: "読者",
    },
    storage: { downloadUrl: async (key) => `https://files.example.com/${key}?sig=1` },
    now: () => now,
  };
  return {
    ctx,
    provider,
    setNow: (d) => {
      now = d;
    },
    advanceDays: (n) => {
      now = new Date(now.getTime() + n * 86_400_000);
    },
  };
}

/** R2 のバケットの代わり（テスト用。メモリに置く） */
export function memoryBucket(): import("../src/providers/r2.js").R2BucketLike & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const toBytes = (v: ArrayBuffer | Uint8Array | string) =>
    typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(v);
  return {
    objects,
    async get(key) {
      const v = objects.get(key);
      if (!v) return null;
      return { key, size: v.length, uploaded: new Date(), body: new Response(v.slice()).body! };
    },
    async put(key, value) {
      objects.set(key, toBytes(value));
      return {};
    },
    async list(o = {}) {
      const keys = [...objects.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).sort();
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 3; // 小さくして、続きの読み出し（cursor）も試す
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((k) => ({ key: k, size: objects.get(k)!.length, uploaded: new Date() })),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
      };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

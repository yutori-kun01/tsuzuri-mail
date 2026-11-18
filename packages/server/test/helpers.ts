import { PGlite } from "@electric-sql/pglite";
import { MemoryProvider } from "@tsuzuri/core";
import type { AppContext } from "../src/context.js";
import { migrate, type Db } from "../src/db.js";

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

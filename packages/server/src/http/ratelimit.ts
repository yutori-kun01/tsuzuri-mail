import type { Context, MiddlewareHandler } from "hono";

/**
 * IP ごとの簡易レート制限（固定ウィンドウ、プロセス内メモリ）。
 * VPS ではリバースプロキシ（Caddy など）の後ろで動く前提で、X-Forwarded-For の**最後**の値をクライアントの IP とみなす。
 * 最後の値は手前のプロキシ自身が付けたもの。先頭は読者が偽って送れる（nginx などは受け取った値の後ろに足すため）。
 * アプリは VPS の 127.0.0.1 でしか受け付けないので、プロキシを通らないリクエストは届かない。
 */
export interface RateRule {
  /** この関数が true を返すリクエストに適用する */
  match: (c: Context) => boolean;
  /** ウィンドウ内に許す回数 */
  limit: number;
  windowMs: number;
  name: string;
}

export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

export function rateLimit(rules: RateRule[], now: () => number = Date.now): MiddlewareHandler {
  const buckets = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return async (c, next) => {
    const t = now();
    // 古い記録を定期的に捨てる（メモリを使い続けないように）
    if (t - lastSweep > 60_000) {
      const maxWindow = Math.max(...rules.map((r) => r.windowMs));
      for (const [k, v] of buckets) if (t - v.start > maxWindow) buckets.delete(k);
      lastSweep = t;
    }
    const ip = clientIp(c);
    for (const rule of rules) {
      if (!rule.match(c)) continue;
      const key = `${rule.name}:${ip}`;
      const b = buckets.get(key);
      if (!b || t - b.start >= rule.windowMs) {
        buckets.set(key, { start: t, count: 1 });
      } else if (++b.count > rule.limit) {
        c.header("Retry-After", String(Math.ceil((rule.windowMs - (t - b.start)) / 1000)));
        return c.text("too many requests", 429);
      }
    }
    await next();
  };
}

/** 公開ページと管理画面の既定のルール */
export const DEFAULT_RULES: RateRule[] = [
  { name: "signup", match: (c) => c.req.method === "POST" && c.req.path.startsWith("/f/"), limit: 10, windowMs: 60_000 },
  { name: "login", match: (c) => c.req.method === "POST" && c.req.path === "/admin/login", limit: 10, windowMs: 60_000 },
  { name: "all", match: () => true, limit: 600, windowMs: 60_000 },
];

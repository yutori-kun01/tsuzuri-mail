import type { Context, MiddlewareHandler } from "hono";

/**
 * IP ごとの簡易レート制限（固定ウィンドウ）。
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

/**
 * 回数を数える仕組み。true なら通す。retryAfterSec は分かるときだけ返す。
 * VPS はプロセス内のメモリ（memoryLimiter）、Cloudflare Workers は Rate Limiting バインディングを使う。
 */
export type RateLimiter = (rule: RateRule, key: string) => Promise<{ ok: boolean; retryAfterSec?: number }>;

export function memoryLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  let maxWindow = 0;
  return async (rule, key) => {
    const t = now();
    maxWindow = Math.max(maxWindow, rule.windowMs);
    // 古い記録を定期的に捨てる（メモリを使い続けないように）
    if (t - lastSweep > 60_000) {
      for (const [k, v] of buckets) if (t - v.start > maxWindow) buckets.delete(k);
      lastSweep = t;
    }
    const id = `${rule.name}:${key}`;
    const b = buckets.get(id);
    if (!b || t - b.start >= rule.windowMs) {
      buckets.set(id, { start: t, count: 1 });
      return { ok: true };
    }
    if (++b.count > rule.limit) return { ok: false, retryAfterSec: Math.ceil((rule.windowMs - (t - b.start)) / 1000) };
    return { ok: true };
  };
}

export interface RateLimitOptions {
  limiter: RateLimiter;
  /** 接続元の見分け方（VPS は X-Forwarded-For の最後、Workers は CF-Connecting-IP） */
  clientKey?: (c: Context) => string;
}

export function rateLimit(rules: RateRule[], nowOrOptions: (() => number) | RateLimitOptions = Date.now): MiddlewareHandler {
  const opts: RateLimitOptions = typeof nowOrOptions === "function" ? { limiter: memoryLimiter(nowOrOptions) } : nowOrOptions;
  const keyOf = opts.clientKey ?? clientIp;
  return async (c, next) => {
    const key = keyOf(c);
    for (const rule of rules) {
      if (!rule.match(c)) continue;
      const r = await opts.limiter(rule, key);
      if (!r.ok) {
        if (r.retryAfterSec !== undefined) c.header("Retry-After", String(r.retryAfterSec));
        return c.text("too many requests", 429);
      }
    }
    await next();
  };
}

/** Cloudflare Workers：接続元の IP（Cloudflare が付ける。読者が偽れない） */
export function cloudflareClientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/** 公開ページと管理画面の既定のルール */
export const DEFAULT_RULES: RateRule[] = [
  { name: "signup", match: (c) => c.req.method === "POST" && c.req.path.startsWith("/f/"), limit: 10, windowMs: 60_000 },
  { name: "login", match: (c) => c.req.method === "POST" && c.req.path === "/admin/login", limit: 10, windowMs: 60_000 },
  { name: "all", match: () => true, limit: 600, windowMs: 60_000 },
];

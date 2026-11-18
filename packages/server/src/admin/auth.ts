import { createToken, verifyPassword, verifyToken, verifyTotp } from "@tsuzuri/core";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";

export const SESSION_COOKIE = "tz_admin";
const SESSION_HOURS = 12;
/** この回数ログインに失敗すると、LOCK_MINUTES の間ログインを受け付けない */
export const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export async function audit(db: Db, action: string, target?: string, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query("INSERT INTO admin_audit (action, target, detail) VALUES ($1, $2, $3)", [action, target ?? null, JSON.stringify(detail)]);
}

export async function isLocked(ctx: AppContext): Promise<boolean> {
  const since = new Date(ctx.now().getTime() - LOCK_MINUTES * 60_000);
  const [r] = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_login_failures WHERE occurred_at > $1", [since]);
  return (r?.n ?? 0) >= MAX_FAILURES;
}

export type LoginResult = "ok" | "locked" | "invalid" | "disabled";

/** パスワードと認証アプリのコードを両方確かめる。失敗は記録してロックに使う。 */
export async function login(ctx: AppContext, password: string, code: string): Promise<LoginResult> {
  if (!ctx.admin) return "disabled";
  if (await isLocked(ctx)) return "locked";
  const ok = verifyPassword(password, ctx.admin.passwordHash) && verifyTotp(ctx.admin.totpSecret, code.trim(), ctx.now());
  if (!ok) {
    await ctx.db.query("INSERT INTO admin_login_failures (occurred_at) VALUES ($1)", [ctx.now()]);
    await audit(ctx.db, "admin.login_failed");
    return (await isLocked(ctx)) ? "locked" : "invalid";
  }
  await ctx.db.query("DELETE FROM admin_login_failures");
  await audit(ctx.db, "admin.login");
  return "ok";
}

function secure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export function startSession(c: Context, ctx: AppContext): void {
  const exp = ctx.now().getTime() + SESSION_HOURS * 3_600_000;
  setCookie(c, SESSION_COOKIE, createToken("admin", String(exp), ctx.secret), {
    httpOnly: true,
    secure: secure(c),
    sameSite: "Strict",
    path: "/admin",
    maxAge: SESSION_HOURS * 3600,
  });
}

export function endSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/admin", secure: secure(c) });
}

export function hasSession(c: Context, ctx: AppContext): boolean {
  const token = getCookie(c, SESSION_COOKIE);
  const exp = token ? Number(verifyToken(token, "admin", ctx.secret)) : NaN;
  return Number.isFinite(exp) && exp > ctx.now().getTime();
}

/**
 * ログイン必須 ＋ 書き込み（POST）は同じサイトからのものだけ受け付ける（CSRF 対策。
 * Cookie の SameSite=Strict と、Origin / Sec-Fetch-Site の確認を重ねる）
 */
export function requireAdmin(getCtx: () => Promise<AppContext>): MiddlewareHandler {
  return async (c, next) => {
    const ctx = await getCtx();
    if (!hasSession(c, ctx)) {
      return c.req.method === "GET" ? c.redirect("/admin/login", 303) : c.text("unauthorized", 401);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const site = c.req.header("sec-fetch-site");
      const origin = c.req.header("origin");
      const own = [new URL(c.req.url).origin, ctx.publicBaseUrl ? new URL(ctx.publicBaseUrl).origin : ""];
      const sameSite = site ? site === "same-origin" : origin !== undefined && own.includes(origin);
      if (!sameSite) return c.text("forbidden", 403);
    }
    await next();
  };
}

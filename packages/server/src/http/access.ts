import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

/**
 * Cloudflare Access が付ける JWT（Cf-Access-Jwt-Assertion ヘッダー、または CF_Authorization Cookie）を確かめる。
 * Access の設定だけに頼らず、Worker 側でも「Access を通ってきたリクエストか」を確かめる（パスの書き方の違いですり抜けられないように）。
 * 鍵は https://<チーム>.cloudflareaccess.com/cdn-cgi/access/certs から取り、しばらく覚えておく。
 */
export interface AccessConfig {
  /** 例 "example.cloudflareaccess.com"（https:// は付けない） */
  teamDomain: string;
  /** Access のアプリケーションの AUD タグ */
  aud: string;
  /** テスト用に差し替える */
  fetchKeys?: () => Promise<JsonWebKey[]>;
  now?: () => number;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}
interface JwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
}

const KEY_CACHE_MS = 10 * 60_000;
let cache: { team: string; at: number; keys: (JsonWebKey & { kid?: string })[] } | undefined;

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(b64url(s))) as T;
  } catch {
    return undefined;
  }
}

async function keysFor(cfg: AccessConfig, now: number): Promise<(JsonWebKey & { kid?: string })[]> {
  if (cache && cache.team === cfg.teamDomain && now - cache.at < KEY_CACHE_MS) return cache.keys;
  const keys = cfg.fetchKeys
    ? await cfg.fetchKeys()
    : (((await (await fetch(`https://${cfg.teamDomain}/cdn-cgi/access/certs`)).json()) as { keys?: JsonWebKey[] }).keys ?? []);
  cache = { team: cfg.teamDomain, at: now, keys };
  return keys;
}

/** 正しければ JWT の中身を、だめなら undefined を返す */
export async function verifyAccessJwt(token: string, cfg: AccessConfig): Promise<JwtPayload | undefined> {
  const now = (cfg.now ?? Date.now)();
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [h, p, sig] = parts as [string, string, string];
  const header = decodeJson<JwtHeader>(h);
  const payload = decodeJson<JwtPayload>(p);
  if (!header || !payload || header.alg !== "RS256" || !header.kid) return undefined;
  let jwk = (await keysFor(cfg, now)).find((k) => k.kid === header.kid);
  if (!jwk) {
    // 鍵が入れ替わった直後のために、1 回だけ取り直す
    cache = undefined;
    jwk = (await keysFor(cfg, now)).find((k) => k.kid === header.kid);
  }
  if (!jwk) return undefined;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return undefined;
  const sec = Math.floor(now / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(cfg.aud)) return undefined;
  if (payload.iss !== `https://${cfg.teamDomain}`) return undefined;
  if (typeof payload.exp !== "number" || payload.exp < sec) return undefined;
  if (typeof payload.nbf === "number" && payload.nbf > sec + 60) return undefined;
  return payload;
}

/** Access を通っていないリクエストは 403 にする */
export function requireAccess(cfg: AccessConfig): MiddlewareHandler {
  return async (c, next) => {
    const token = c.req.header("cf-access-jwt-assertion") ?? getCookie(c, "CF_Authorization");
    const ok = token ? await verifyAccessJwt(token, cfg).catch(() => undefined) : undefined;
    if (!ok) return c.text("forbidden", 403);
    await next();
  };
}

/** テスト用：覚えた鍵を捨てる */
export function resetAccessKeyCache(): void {
  cache = undefined;
}

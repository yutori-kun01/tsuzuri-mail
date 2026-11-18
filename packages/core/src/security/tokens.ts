import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 配信停止・配信設定ページ用の署名付きトークン。
 * 中身は「用途:対象id」のみで、メールアドレスは含めない。
 */
export type TokenPurpose = "unsubscribe" | "preferences" | "confirm" | "click" | "open" | "download" | "read" | "admin" | "file";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createToken(purpose: TokenPurpose, contactId: string, secret: string): string {
  if (secret.length < 32) throw new Error("secret must be at least 32 characters");
  const payload = `${purpose}:${contactId}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload, secret)}`;
}

/** 正しければ contactId を、改ざん・用途違いなら undefined を返す。 */
export function verifyToken(token: string, purpose: TokenPurpose, secret: string): string | undefined {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return undefined;
  const payload = Buffer.from(encoded, "base64url").toString();
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  const sep = payload.indexOf(":");
  if (payload.slice(0, sep) !== purpose) return undefined;
  const contactId = payload.slice(sep + 1);
  return contactId === "" ? undefined : contactId;
}

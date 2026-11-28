import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { base32Decode, base32Encode } from "./auth.js";

/**
 * データの引き継ぎファイルの暗号化（AES-256-GCM）。
 *
 * - 書き出すたびに新しい 256 ビットの鍵を作り、画面に 1 回だけ見せる。鍵はサーバーに保存しない。
 * - 鍵の文字列は「TZK1-」＋ Base32（鍵 32 バイト＋確認用 4 バイト。大文字小文字を区別しない）。打ち間違いは確認用の 4 バイトで先に見つける。
 * - ファイルは「TZX1」（4 バイト）＋ IV（12 バイト）＋ 暗号文 ＋ 認証タグ（16 バイト）。中身は gzip した JSON。
 *   先頭の 4 バイトは認証の対象（AAD）に含める。鍵が違う・ファイルが壊れている・書き換えられた場合は復号できない。
 */

const MAGIC = Buffer.from("TZX1");
const KEY_PREFIX = "TZK1-";
const IV_LEN = 12;
const TAG_LEN = 16;

export class TransferKeyError extends Error {}

const check = (key: Buffer) => createHash("sha256").update(key).digest().subarray(0, 4);

export function generateTransferKey(): { key: Buffer; text: string } {
  const key = randomBytes(32);
  return { key, text: formatTransferKey(key) };
}

export function formatTransferKey(key: Buffer): string {
  const body = base32Encode(Buffer.concat([key, check(key)]));
  // 読み写ししやすいよう 6 文字ごとに区切る
  return KEY_PREFIX + (body.match(/.{1,6}/g) ?? []).join("-");
}

/** 鍵の文字列を読む（前後の空白・区切りのハイフン・改行は無視する） */
export function parseTransferKey(text: string): Buffer {
  const t = text.trim();
  if (!t.toUpperCase().startsWith(KEY_PREFIX)) throw new TransferKeyError("暗号化キーは「TZK1-」で始まります");
  const body = t.slice(KEY_PREFIX.length).replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(body)) throw new TransferKeyError("暗号化キーに使えない文字が入っています");
  const raw = base32Decode(body);
  if (raw.length !== 36) throw new TransferKeyError("暗号化キーの長さが違います（途中で切れていないか確認してください）");
  const key = raw.subarray(0, 32);
  if (!timingSafeEqual(raw.subarray(32), check(key))) throw new TransferKeyError("暗号化キーが正しくありません（打ち間違いがないか確認してください）");
  return Buffer.from(key);
}

export function encryptTransfer(plain: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new TransferKeyError("bad key length");
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

export function isTransferFile(buf: Buffer): boolean {
  return buf.length > MAGIC.length + IV_LEN + TAG_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptTransfer(file: Buffer, key: Buffer): Buffer {
  if (!isTransferFile(file)) throw new TransferKeyError("tsuzuri-mail の引き継ぎファイルではありません");
  const iv = file.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = file.subarray(file.length - TAG_LEN);
  const body = file.subarray(MAGIC.length + IV_LEN, file.length - TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  let zipped: Buffer;
  try {
    zipped = Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new TransferKeyError("復号できませんでした（暗号化キーが違うか、ファイルが壊れています）");
  }
  return gunzipSync(zipped);
}

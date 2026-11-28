import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/**
 * パスキー（WebAuthn）の検証。外部ライブラリを使わず、Node の crypto だけで行う。
 *
 * - 登録：attestation は "none" を求め、証明書の連鎖は確かめない（使う人は管理者 1 人で、端末の機種を制限しないため）。
 *   公開鍵・クレデンシャル ID・署名カウンタだけを取り出す。
 * - 認証：clientDataJSON（種類・チャレンジ・オリジン）、authenticatorData（RP ID のハッシュ・ユーザー確認のフラグ）、
 *   署名（authenticatorData ‖ SHA-256(clientDataJSON)）を確かめる。
 * - 本人確認（UV：生体認証や端末の PIN）を必須にする。パスキー 1 つでパスワード＋認証アプリの代わりにするため。
 * - PC でスマホの QR を読み取る方式（ハイブリッド）も、ブラウザと OS が中継するだけで、ここでの検証は同じ。
 *
 * 対応する鍵：ES256（-7）、EdDSA（-8, Ed25519）、RS256（-257）。
 */

export const COSE_ALGS = [-7, -8, -257] as const;
export type CoseAlg = (typeof COSE_ALGS)[number];

export class WebAuthnError extends Error {}

export function newChallenge(): string {
  return randomBytes(32).toString("base64url");
}

const b64u = (s: string): Buffer => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new WebAuthnError("bad base64url");
  return Buffer.from(s, "base64url");
};
const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();

// ---- CBOR（WebAuthn で使う範囲だけ：整数・バイト列・文字列・配列・マップ・true/false/null） ----

type Cbor = number | bigint | Buffer | string | Cbor[] | Map<Cbor, Cbor> | boolean | null | undefined;

export function cborDecode(buf: Buffer, start = 0): { value: Cbor; end: number } {
  let p = start;
  const need = (n: number) => {
    if (p + n > buf.length) throw new WebAuthnError("truncated CBOR");
  };
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf[p++]!;
    }
    if (info === 25) {
      need(2);
      p += 2;
      return buf.readUInt16BE(p - 2);
    }
    if (info === 26) {
      need(4);
      p += 4;
      return buf.readUInt32BE(p - 4);
    }
    if (info === 27) {
      need(8);
      const v = buf.readBigUInt64BE(p);
      p += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError("CBOR length too large");
      return Number(v);
    }
    throw new WebAuthnError("unsupported CBOR length");
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new WebAuthnError("CBOR too deep");
    need(1);
    const b = buf[p++]!;
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0:
        return readLen(info);
      case 1:
        return -1 - readLen(info);
      case 2: {
        const n = readLen(info);
        need(n);
        const v = Buffer.from(buf.subarray(p, p + n));
        p += n;
        return v;
      }
      case 3: {
        const n = readLen(info);
        need(n);
        const v = buf.toString("utf8", p, p + n);
        p += n;
        return v;
      }
      case 4: {
        const n = readLen(info);
        const arr: Cbor[] = [];
        for (let i = 0; i < n; i++) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const n = readLen(info);
        const map = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          map.set(k, item(depth + 1));
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new WebAuthnError("unsupported CBOR simple value");
      default:
        throw new WebAuthnError("unsupported CBOR type");
    }
  };
  const value = item(0);
  return { value, end: p };
}

// ---- authenticatorData ----

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  publicKey?: Map<Cbor, Cbor>;
}

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new WebAuthnError("authenticatorData too short");
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32]!;
  const signCount = buf.readUInt32BE(33);
  if (!(flags & FLAG_AT)) return { rpIdHash, flags, signCount };
  if (buf.length < 55) throw new WebAuthnError("attested credential data too short");
  const idLen = buf.readUInt16BE(53);
  if (buf.length < 55 + idLen) throw new WebAuthnError("credential id truncated");
  const credentialId = buf.subarray(55, 55 + idLen);
  const { value } = cborDecode(buf, 55 + idLen);
  if (!(value instanceof Map)) throw new WebAuthnError("credential public key is not a map");
  return { rpIdHash, flags, signCount, credentialId, publicKey: value };
}

/** COSE の公開鍵を、検証に使える形（SPKI DER）にする */
export function coseToSpki(cose: Map<Cbor, Cbor>): { spki: Buffer; alg: CoseAlg } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (k: number) => {
    const v = cose.get(k);
    if (!Buffer.isBuffer(v)) throw new WebAuthnError(`COSE key parameter ${k} missing`);
    return v.toString("base64url");
  };
  let key: KeyObject;
  if (kty === 2 && alg === -7) {
    if (cose.get(-1) !== 1) throw new WebAuthnError("only P-256 is supported for ES256");
    key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) }, format: "jwk" });
  } else if (kty === 1 && alg === -8) {
    if (cose.get(-1) !== 6) throw new WebAuthnError("only Ed25519 is supported for EdDSA");
    key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes(-2) }, format: "jwk" });
  } else if (kty === 3 && alg === -257) {
    key = createPublicKey({ key: { kty: "RSA", n: bytes(-1), e: bytes(-2) }, format: "jwk" });
  } else {
    throw new WebAuthnError("unsupported key type");
  }
  return { spki: key.export({ type: "spki", format: "der" }), alg: alg as CoseAlg };
}

// ---- clientDataJSON ----

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function checkClientData(raw: Buffer, type: "webauthn.create" | "webauthn.get", challenge: string, origins: readonly string[]): void {
  let cd: ClientData;
  try {
    cd = JSON.parse(raw.toString("utf8")) as ClientData;
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON");
  }
  if (cd.type !== type) throw new WebAuthnError("unexpected clientData type");
  const a = Buffer.from(String(cd.challenge));
  const b = Buffer.from(challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebAuthnError("challenge mismatch");
  if (!origins.includes(cd.origin)) throw new WebAuthnError("origin mismatch");
  if (cd.crossOrigin === true) throw new WebAuthnError("cross-origin request");
}

function checkRpAndFlags(ad: AuthData, rpId: string): void {
  if (!timingSafeEqual(ad.rpIdHash, sha256(rpId))) throw new WebAuthnError("rpId mismatch");
  if (!(ad.flags & FLAG_UP)) throw new WebAuthnError("user not present");
  if (!(ad.flags & FLAG_UV)) throw new WebAuthnError("user not verified");
}

// ---- 登録 ----

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export interface VerifiedCredential {
  /** base64url */
  credentialId: string;
  /** SPKI DER の base64url */
  publicKey: string;
  alg: CoseAlg;
  signCount: number;
  transports: string[];
}

export function verifyRegistration(o: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  expectedOrigins: readonly string[];
  rpId: string;
}): VerifiedCredential {
  const r = o.response;
  if (!r || r.type !== "public-key" || !r.response) throw new WebAuthnError("not a public-key credential");
  checkClientData(b64u(r.response.clientDataJSON), "webauthn.create", o.expectedChallenge, o.expectedOrigins);
  const { value: att } = cborDecode(b64u(r.response.attestationObject));
  if (!(att instanceof Map)) throw new WebAuthnError("attestationObject is not a map");
  const authData = att.get("authData");
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError("authData missing");
  const ad = parseAuthData(authData);
  checkRpAndFlags(ad, o.rpId);
  if (!ad.credentialId || !ad.publicKey) throw new WebAuthnError("no attested credential");
  const credentialId = ad.credentialId.toString("base64url");
  if (b64u(r.rawId).toString("base64url") !== credentialId) throw new WebAuthnError("credential id mismatch");
  const { spki, alg } = coseToSpki(ad.publicKey);
  const transports = Array.isArray(r.response.transports)
    ? r.response.transports.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,20}$/.test(t)).slice(0, 8)
    : [];
  return { credentialId, publicKey: spki.toString("base64url"), alg, signCount: ad.signCount, transports };
}

// ---- 認証 ----

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

export function verifyAuthentication(o: {
  response: AuthenticationResponseJSON;
  credential: { publicKey: string; alg: number; signCount: number };
  expectedChallenge: string;
  expectedOrigins: readonly string[];
  rpId: string;
}): { newSignCount: number } {
  const r = o.response;
  if (!r || r.type !== "public-key" || !r.response) throw new WebAuthnError("not a public-key credential");
  const clientData = b64u(r.response.clientDataJSON);
  checkClientData(clientData, "webauthn.get", o.expectedChallenge, o.expectedOrigins);
  const authData = b64u(r.response.authenticatorData);
  const ad = parseAuthData(authData);
  checkRpAndFlags(ad, o.rpId);
  const key = createPublicKey({ key: Buffer.from(o.credential.publicKey, "base64url"), format: "der", type: "spki" });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const sig = b64u(r.response.signature);
  const ok =
    o.credential.alg === -8
      ? verify(null, signed, key, sig)
      : o.credential.alg === -7 || o.credential.alg === -257
        ? verify("sha256", signed, key, sig)
        : false;
  if (!ok) throw new WebAuthnError("bad signature");
  // カウンタが両方 0 でなく、増えていなければ複製された鍵の疑い（同期するパスキーは常に 0）
  if ((ad.signCount !== 0 || o.credential.signCount !== 0) && ad.signCount <= o.credential.signCount) {
    throw new WebAuthnError("signature counter did not increase");
  }
  return { newSignCount: ad.signCount };
}

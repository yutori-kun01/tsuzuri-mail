import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { FLAG_AT, FLAG_UP, FLAG_UV } from "./webauthn.js";

/** テスト専用：パスキーの認証器のまねごと（index.ts からは公開しない） */

/** テスト用の最小の CBOR エンコーダ */
export function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("unsupported");
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** 認証器のまねごと（ES256 か Ed25519） */
export function authenticator(kind: "ec" | "ed", RP = "mail.example.com", ORIGIN = "https://mail.example.com") {
  const { privateKey, publicKey } = kind === "ec" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const cose =
    kind === "ec"
      ? new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]])
      : new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, "base64url")]]);
  const credId = Buffer.from("credential-id-123");
  let counter = 0;
  const authData = (flags: number, withCred: boolean, rp = RP) => {
    const head = Buffer.alloc(37);
    sha(rp).copy(head, 0);
    head[32] = flags | (withCred ? FLAG_AT : 0);
    head.writeUInt32BE(counter, 33);
    if (!withCred) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, credId, cbor(cose)]);
  };
  const clientData = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }));
  return {
    register(challenge: string, o: { flags?: number; origin?: string; rp?: string } = {}) {
      const ad = authData(o.flags ?? FLAG_UP | FLAG_UV, true, o.rp);
      return {
        id: credId.toString("base64url"),
        rawId: credId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientData("webauthn.create", challenge, o.origin).toString("base64url"),
          attestationObject: cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]])).toString("base64url"),
          transports: ["hybrid", "internal"],
        },
      };
    },
    login(challenge: string, o: { flags?: number; tamper?: boolean; bump?: number; key?: KeyObject } = {}) {
      counter += o.bump ?? 0;
      const ad = authData(o.flags ?? FLAG_UP | FLAG_UV, false);
      const cd = clientData("webauthn.get", challenge);
      const data = Buffer.concat([ad, sha(cd)]);
      const sig = kind === "ec" ? sign("sha256", data, o.key ?? privateKey) : sign(null, data, o.key ?? privateKey);
      if (o.tamper) sig[sig.length - 1] = sig[sig.length - 1]! ^ 1;
      return {
        id: credId.toString("base64url"),
        rawId: credId.toString("base64url"),
        type: "public-key",
        response: { clientDataJSON: cd.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: sig.toString("base64url"), userHandle: null },
      };
    },
  };
}


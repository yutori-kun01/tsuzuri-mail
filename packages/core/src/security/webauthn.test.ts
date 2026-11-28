import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticator, cbor } from "./webauthn-testkit.js";
import { cborDecode, FLAG_UP, newChallenge, verifyAuthentication, verifyRegistration, WebAuthnError } from "./webauthn.js";

const RP = "mail.example.com";
const ORIGIN = "https://mail.example.com";

describe("CBOR", () => {
  it("decodes maps, negative ints, byte and text strings", () => {
    const { value } = cborDecode(cbor(new Map<unknown, unknown>([[1, 2], [-7, Buffer.from([1, 2])], ["k", "値"]])));
    expect(value).toEqual(new Map<unknown, unknown>([[1, 2], [-7, Buffer.from([1, 2])], ["k", "値"]]));
  });
  it("rejects truncated input", () => {
    expect(() => cborDecode(Buffer.from([0x45, 1, 2]))).toThrow(WebAuthnError);
  });
});

describe.each(["ec", "ed"] as const)("passkey %s", (kind) => {
  it("registers and then logs in", () => {
    const a = authenticator(kind);
    const ch = newChallenge();
    const cred = verifyRegistration({ response: a.register(ch), expectedChallenge: ch, expectedOrigins: [ORIGIN], rpId: RP });
    expect(cred.credentialId).toBe(Buffer.from("credential-id-123").toString("base64url"));
    expect(cred.alg).toBe(kind === "ec" ? -7 : -8);
    expect(cred.transports).toEqual(["hybrid", "internal"]);
    const ch2 = newChallenge();
    expect(verifyAuthentication({ response: a.login(ch2), credential: cred, expectedChallenge: ch2, expectedOrigins: [ORIGIN], rpId: RP })).toEqual({ newSignCount: 0 });
  });

  it("rejects a wrong challenge, origin, RP, missing user verification or a bad signature", () => {
    const a = authenticator(kind);
    const ch = newChallenge();
    const base = { expectedChallenge: ch, expectedOrigins: [ORIGIN], rpId: RP };
    expect(() => verifyRegistration({ ...base, response: a.register(newChallenge()) })).toThrow("challenge");
    expect(() => verifyRegistration({ ...base, response: a.register(ch, { origin: "https://evil.example" }) })).toThrow("origin");
    expect(() => verifyRegistration({ ...base, response: a.register(ch, { rp: "evil.example" }) })).toThrow("rpId");
    expect(() => verifyRegistration({ ...base, response: a.register(ch, { flags: FLAG_UP }) })).toThrow("verified");
    const cred = verifyRegistration({ ...base, response: a.register(ch) });
    expect(() => verifyAuthentication({ ...base, credential: cred, response: a.login(ch, { tamper: true }) })).toThrow("signature");
    const other = kind === "ec" ? generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey : generateKeyPairSync("ed25519").privateKey;
    expect(() => verifyAuthentication({ ...base, credential: cred, response: a.login(ch, { key: other }) })).toThrow("signature");
    expect(() => verifyAuthentication({ ...base, credential: cred, response: a.login(ch, { flags: FLAG_UP }) })).toThrow("verified");
  });

  it("rejects a counter that went backwards", () => {
    const a = authenticator(kind);
    const ch = newChallenge();
    const base = { expectedChallenge: ch, expectedOrigins: [ORIGIN], rpId: RP };
    const cred = verifyRegistration({ ...base, response: a.register(ch) });
    expect(verifyAuthentication({ ...base, credential: cred, response: a.login(ch, { bump: 5 }) }).newSignCount).toBe(5);
    expect(() => verifyAuthentication({ ...base, credential: { ...cred, signCount: 5 }, response: a.login(ch) })).toThrow("counter");
  });
});

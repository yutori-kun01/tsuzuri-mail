import { generateTransferKey, MemoryProvider } from "@tsuzuri/core";
import { describe, expect, it } from "vitest";
import { resetAccessKeyCache, verifyAccessJwt } from "../src/http/access.js";
import { AwsHttp, SesHttpProvider, SqsHttp } from "../src/providers/aws-http.js";
import { backupToR2, bundleStream, listBackups, pruneR2Backups, readBundle } from "../src/services/cloud-backup.js";
import { applyTransfer, checkPayload } from "../src/services/transfer.js";
import { createWorker, NIGHTLY_CRON, type Env } from "../src/workers/worker.js";
import { createEnv, memoryBucket } from "./helpers.js";

const BASE = "https://tsuzuri.example.workers.dev";

async function setup(extra: Partial<Env> = {}) {
  const t = await createEnv();
  await t.ctx.db.query("INSERT INTO forms (slug, name, consent_text_version, double_optin) VALUES ('news', 'ニュースレター', 'v1', true)");
  await t.ctx.db.query("INSERT INTO app_settings (id, settings) VALUES (1, $1)", [
    JSON.stringify({ fromAddress: "info@ml.example.com", fromName: "つづり", senderName: "つづり", senderAddress: "東京都", contact: "https://example.com/contact" }),
  ]);
  const provider = new MemoryProvider();
  const files = memoryBucket();
  const backups = memoryBucket();
  const env: Env = { TOKEN_SECRET: "s".repeat(40), PUBLIC_BASE_URL: BASE, FILES: files, BACKUPS: backups, ...extra };
  const waits: Promise<unknown>[] = [];
  const ec = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const worker = createWorker({ openDb: () => t.ctx.db, provider: () => provider, now: () => t.ctx.now(), sleep: async () => {} });
  const fetch = async (path: string, init?: RequestInit) => {
    const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ec);
    await Promise.all(waits.splice(0));
    return res;
  };
  return { t, env, provider, files, backups, worker, ec, fetch, waits };
}

describe("Cloudflare Workers の入り口", () => {
  it("登録すると、応答のあとに確認メールを送る（waitUntil）。毎分の処理でシナリオも送る", async () => {
    const s = await setup();
    expect((await s.fetch("/health")).status).toBe(200);
    const res = await s.fetch("/f/news", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=reader%40example.com" });
    expect(res.status).toBe(303);
    expect(s.provider.sent.map((m) => m.subject)).toHaveLength(1);
    // 本文のリンクはアプリの URL（LINK_BASE_URL が無いとき）
    expect(s.provider.sent[0]!.text).toContain(`${BASE}/confirm/`);

    await s.worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, s.env, s.ec);
    await Promise.all(s.waits.splice(0));
  });

  it("LINK_BASE_URL を入れると本文のリンクだけが変わり、ワンクリック配信停止のヘッダーはアプリへ直接向く", async () => {
    const s = await setup({ LINK_BASE_URL: "https://ml.example.com" });
    const [seq] = await s.t.ctx.db.query<{ id: string }>("INSERT INTO sequences (slug, name, status) VALUES ('w', 'ようこそ', 'active') RETURNING id");
    await s.t.ctx.db.query("INSERT INTO sequence_steps (sequence_id, position, subject, body_markdown, delay_minutes) VALUES ($1, 1, 'ようこそ', '本文 https://example.com/a', 0)", [seq!.id]);
    await s.t.ctx.db.query("UPDATE forms SET sequence_id = $1, double_optin = false", [seq!.id]);
    await s.fetch("/f/news", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=reader%40example.com" });
    const m = s.provider.sent.find((x) => x.subject === "ようこそ")!;
    expect(m).toBeTruthy();
    expect(m.text).toContain("https://ml.example.com/u/");
    expect(m.html).toContain("https://ml.example.com/c/");
    expect(m.headers["List-Unsubscribe"]).toContain(`<${BASE}/u/`);
  });

  it("SURFACES で読者向けと管理画面を分けられる", async () => {
    const pub = await setup({ SURFACES: "public" });
    expect((await pub.fetch("/admin/login")).status).toBe(404);
    expect((await pub.fetch("/f/news")).status).toBe(200);
    const adm = await setup({ SURFACES: "admin" });
    expect((await adm.fetch("/f/news")).status).toBe(404);
    expect((await adm.fetch("/health")).status).toBe(200);
    expect((await adm.fetch("/admin/login")).status).toBe(503); // ログイン情報が未設定
  });

  it("Access の設定があれば、JWT の無い管理画面へのリクエストを断る（パスの書き方を変えても）", async () => {
    const s = await setup({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-1" });
    expect((await s.fetch("/admin/login")).status).toBe(403);
    expect((await s.fetch("/%61dmin/login")).status).toBe(403);
    expect((await s.fetch("/f/news")).status).toBe(200);
  });

  it("Rate Limiting バインディングで、接続元ごとに数える", async () => {
    const counts = new Map<string, number>();
    const limiter = (limit: number) => ({
      async limit({ key }: { key: string }) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= limit };
      },
    });
    const s = await setup({ SIGNUP_LIMITER: limiter(2), LOGIN_LIMITER: limiter(1) });
    const post = (ip: string) => s.fetch("/f/news", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip }, body: "email=a%40example.com" });
    expect((await post("client-a")).status).toBe(303);
    expect((await post("client-a")).status).toBe(303);
    expect((await post("client-a")).status).toBe(429);
    expect((await post("client-b")).status).toBe(303);
    // 管理画面のログインにも効く（以前は /admin より後に入れていたため効いていなかった）
    const login = () => s.fetch("/admin/login", { method: "POST", headers: { "cf-connecting-ip": "client-c", "content-type": "application/x-www-form-urlencoded" }, body: "password=x&code=000000" });
    expect((await login()).status).not.toBe(429);
    expect((await login()).status).toBe(429);
  });

  it("毎晩の処理で R2 にバックアップを取り、ダウンロードしたものを別の DB に戻せる", async () => {
    const key = generateTransferKey();
    const s = await setup({ BACKUP_ENCRYPTION_KEY: key.text, BACKUP_KEEP_DAYS: "30" });
    await s.fetch("/f/news", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=reader%40example.com" });
    await s.worker.scheduled({ cron: NIGHTLY_CRON, scheduledTime: Date.now() }, s.env, s.ec);
    const days = await listBackups(s.backups);
    expect(days).toHaveLength(1);
    expect(days[0]!.complete).toBe(true);
    // 中身は暗号化されている（メールアドレスがそのまま入っていない）
    for (const v of s.backups.objects.values()) expect(Buffer.from(v).toString("latin1")).not.toContain("reader@example.com");

    const stream = await bundleStream(s.backups, days[0]!.day);
    const file = Buffer.from(await new Response(stream).arrayBuffer());
    const payload = readBundle(file, key.key);
    const target = await createEnv();
    const checked = await checkPayload(target.ctx, payload);
    expect(checked.sameSecret).toBe(true);
    await applyTransfer(target.ctx, payload);
    const rows = await target.ctx.db.query<{ address: string }>("SELECT address FROM channels");
    expect(rows.map((r) => r.address)).toEqual(["reader@example.com"]);
  });
});

describe("R2 のバックアップ", () => {
  it("小さく分けて書き、行数をそろえて読み戻す。古い日は消す", async () => {
    const t = await createEnv();
    for (let i = 0; i < 7; i++) await t.ctx.db.query("INSERT INTO tags (name, category) VALUES ($1, 'cust')", [`t${i}`]);
    const bucket = memoryBucket();
    const key = generateTransferKey().key;
    const r = await backupToR2(t.ctx, bucket, key, "2026-11-01", 3);
    expect(r.rows).toBeGreaterThanOrEqual(7);
    expect([...bucket.objects.keys()].filter((k) => k.includes("/tags.")).length).toBe(3); // 7 行を 3 行ずつ
    const payload = readBundle(Buffer.from(await new Response(await bundleStream(bucket, "2026-11-01")).arrayBuffer()), key);
    expect(payload.tables.tags!.rows).toHaveLength(7);
    // 違う鍵では読めない
    const again = Buffer.from(await new Response(await bundleStream(bucket, "2026-11-01")).arrayBuffer());
    expect(() => readBundle(again, generateTransferKey().key)).toThrow();
    // 同じ日に取り直しても、前の分は残らない
    await backupToR2(t.ctx, bucket, key, "2026-11-01", 100);
    expect([...bucket.objects.keys()].filter((k) => k.includes("/tags.")).length).toBe(1);
    await backupToR2(t.ctx, bucket, key, "2026-11-20", 100);
    expect(await pruneR2Backups(bucket, 10, new Date("2026-11-25T00:00:00Z"))).toBe(1);
    expect((await listBackups(bucket)).map((d) => d.day)).toEqual(["2026-11-20"]);
    expect(await bundleStream(bucket, "2026-11-01")).toBeUndefined();
  });
});

describe("Cloudflare Access の JWT", () => {
  it("署名・aud・iss・期限を確かめる", async () => {
    resetAccessKeyCache();
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
    const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
    const now = 1_800_000_000_000;
    const sign = async (payload: Record<string, unknown>, kid = "k1") => {
      const h = b64(Buffer.from(JSON.stringify({ alg: "RS256", kid })));
      const p = b64(Buffer.from(JSON.stringify(payload)));
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64(sig)}`;
    };
    const cfg = { teamDomain: "team.cloudflareaccess.com", aud: "aud-1", fetchKeys: async () => [jwk], now: () => now };
    const good = { aud: ["aud-1"], iss: "https://team.cloudflareaccess.com", exp: now / 1000 + 60 };
    expect(await verifyAccessJwt(await sign(good), cfg)).toBeTruthy();
    expect(await verifyAccessJwt(await sign({ ...good, aud: ["other"] }), cfg)).toBeUndefined();
    expect(await verifyAccessJwt(await sign({ ...good, iss: "https://evil.example.com" }), cfg)).toBeUndefined();
    expect(await verifyAccessJwt(await sign({ ...good, exp: now / 1000 - 1 }), cfg)).toBeUndefined();
    expect(await verifyAccessJwt(await sign(good, "unknown"), cfg)).toBeUndefined();
    const tampered = (await sign(good)).replace(/\.[^.]+\./, `.${b64(Buffer.from(JSON.stringify({ ...good, aud: ["aud-1", "x"] })))}.`);
    expect(await verifyAccessJwt(tampered, cfg)).toBeUndefined();
  });
});

describe("AWS を HTTPS で直接呼ぶ", () => {
  it("SES の SendEmail と SQS の受信・削除を、署名付きで送る", async () => {
    const calls: { url: string; target: string | null; auth: string | null; body: string }[] = [];
    const aws = new AwsHttp({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "test-secret-not-real",
      region: "ap-northeast-1",
      fetch: async (req) => {
        calls.push({ url: req.url, target: req.headers.get("x-amz-target"), auth: req.headers.get("authorization"), body: await req.text() });
        if (req.url.includes("outbound-emails")) return Response.json({ MessageId: "m-1" });
        if (req.headers.get("x-amz-target") === "AmazonSQS.ReceiveMessage") return Response.json({ Messages: [{ Body: "{}", ReceiptHandle: "rh-1" }] });
        return Response.json({});
      },
    });
    const ses = new SesHttpProvider(aws, "tsuzuri");
    const r = await ses.send({
      idempotencyKey: "k",
      to: "reader@example.com",
      from: { address: "info@ml.example.com", name: "つづり通信" },
      subject: "件名",
      html: "<p>x</p>",
      text: "x",
      headers: { "List-Unsubscribe": "<https://example.com/u/t>" },
      tags: { message_id: "m 1" },
    });
    expect(r.providerMessageId).toBe("m-1");
    expect(calls[0]!.url).toBe("https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails");
    expect(calls[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-1\/ses\/aws4_request/);
    const body = JSON.parse(calls[0]!.body);
    expect(body.ConfigurationSetName).toBe("tsuzuri");
    expect(body.FromEmailAddress).toMatch(/^=\?UTF-8\?B\?/);
    expect(body.Content.Simple.Headers).toEqual([{ Name: "List-Unsubscribe", Value: "<https://example.com/u/t>" }]);
    expect(body.EmailTags).toEqual([{ Name: "message_id", Value: "m_1" }]);

    const sqs = new SqsHttp(aws, "https://sqs.ap-northeast-1.amazonaws.com/000000000000/tsuzuri-ses-events");
    expect(await sqs.receive()).toEqual([{ body: "{}", receiptHandle: "rh-1" }]);
    await sqs.delete("rh-1");
    expect(calls.slice(1).map((c) => c.target)).toEqual(["AmazonSQS.ReceiveMessage", "AmazonSQS.DeleteMessage"]);
    expect(calls[1]!.auth).toContain("/sqs/aws4_request");
  });

  it("SES のエラーは型名つきで投げる（送信記録は再試行に回る）", async () => {
    const aws = new AwsHttp({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "test-secret-not-real",
      region: "ap-northeast-1",
      fetch: async () => new Response(JSON.stringify({ message: "x" }), { status: 400, headers: { "x-amzn-errortype": "MessageRejected:http://internal" } }),
    });
    await expect(new SesHttpProvider(aws, "tsuzuri").send({ idempotencyKey: "k", to: "a@example.com", from: { address: "b@example.com" }, subject: "s", html: "", text: "", headers: {} })).rejects.toThrow(
      "MessageRejected",
    );
  });
});

describe("管理画面を別の Worker にしたとき", () => {
  it("パスキーは ADMIN_BASE_URL のホストに結びつき、メールのリンクは読者向けの Worker を向く", async () => {
    const t = await createEnv();
    const worker = createWorker({ openDb: () => t.ctx.db, provider: () => new MemoryProvider(), now: () => t.ctx.now() });
    const env: Env = {
      TOKEN_SECRET: "s".repeat(40),
      PUBLIC_BASE_URL: BASE,
      ADMIN_BASE_URL: "https://tsuzuri-admin.example.workers.dev",
      SURFACES: "admin",
      ADMIN_PASSWORD_HASH: "scrypt$1$1$1$x$y",
      ADMIN_TOTP_SECRET: "AAAA",
    };
    const res = await worker.fetch(new Request("https://tsuzuri-admin.example.workers.dev/admin/passkey/login/options", { method: "POST", headers: { "sec-fetch-site": "same-origin" } }), env, { waitUntil: () => {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rpId: string }).rpId).toBe("tsuzuri-admin.example.workers.dev");
  });
});

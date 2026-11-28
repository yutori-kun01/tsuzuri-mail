/**
 * Cloudflare Workers の入り口（本番の標準構成）。
 *
 * - fetch：公開ページ・管理画面・決済の Webhook（Hono のアプリをそのまま使う）
 * - scheduled（Cron Triggers）
 *     毎分      ：自動化 → シナリオと一斉配信を送信待ちに → SES のバウンス・苦情を取りに行く → 送信待ちを送る
 *     毎日 18:00 UTC（日本時間 3:00）：読者スコアの再計算、R2 へのバックアップ、古いデータの削除
 *
 * DB は Supabase の PostgreSQL に Hyperdrive 経由でつなぐ。接続はリクエスト（または Cron の 1 回）ごとに作って閉じる
 * （Workers では I/O の部品をリクエストをまたいで使えないため。接続の使い回しは Hyperdrive が受け持つ）。
 * 設定は wrangler.jsonc の vars、秘密値は `wrangler secret put` で入れる。docs/cloudflare.md 参照。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { parseTransferKey, StripePaymentProvider, type MailProvider, type PaymentProvider } from "@tsuzuri/core";
import type { Hono } from "hono";
import { loadSettings, refreshSettings, settingsFromEnv, type AppContext } from "../context.js";
import { pgDb, type Db } from "../db.js";
import { requireAccess } from "../http/access.js";
import { createApp } from "../http/app.js";
import { cloudflareClientIp, type RateLimiter } from "../http/ratelimit.js";
import { AwsHttp, SesHttpProvider, sesHttpIdentityStatus, SqsHttp } from "../providers/aws-http.js";
import { ConsoleProvider } from "../providers/console.js";
import { R2FileStorage, type R2BucketLike } from "../providers/r2.js";
import { backupDay, backupToR2, pruneR2Backups } from "../services/cloud-backup.js";
import { pruneOldData } from "../services/backup.js";
import { runAutomations } from "../services/automations.js";
import { launchDueBroadcasts } from "../services/broadcasts.js";
import { dueQueuedMessages, stuckSendingCount } from "../services/queue.js";
import { recomputeAllScores } from "../services/scoring.js";
import { sendMessage } from "../services/sending.js";
import { handleSesEvent } from "../services/ses-events.js";
import { scheduleDueSteps } from "../services/sequences.js";
import { parseSesEventBody } from "../vps/ses-events.js";

/** Workers の Rate Limiting バインディング（使う部分だけ） */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Hyperdrive（Supabase の Direct の接続文字列を登録したもの） */
  HYPERDRIVE?: { connectionString: string };
  /** 特典ファイル */
  FILES?: R2BucketLike;
  /** 毎晩のバックアップ */
  BACKUPS?: R2BucketLike;
  SIGNUP_LIMITER?: RateLimitBinding;
  LOGIN_LIMITER?: RateLimitBinding;
  ALL_LIMITER?: RateLimitBinding;

  // ---- vars ----
  /** 読者向けのアプリの URL（フォームの送信先・配信停止のヘッダー・Webhook）。管理画面の Worker でも読者向けの Worker の URL を入れる */
  PUBLIC_BASE_URL?: string;
  LINK_BASE_URL?: string;
  /** 管理画面の Worker の URL（パスキーが結びつくホスト）。管理画面を別の Worker にしたときだけ */
  ADMIN_BASE_URL?: string;
  /** "public,admin"（既定）・"public"・"admin" */
  SURFACES?: string;
  AWS_REGION?: string;
  SES_CONFIGURATION_SET?: string;
  SES_EVENTS_QUEUE_URL?: string;
  /** "console" で送らずにログへ出す（動作確認用） */
  MAIL_PROVIDER?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  MAIL_REPLY_TO?: string;
  MAIL_CONTACT?: string;
  /** 1 秒あたりの送信数（SES の送信レート以下に） */
  MAX_SEND_RATE?: string;
  /** 毎分の送信に使う時間（秒）。次の Cron と重ならないように 60 より短く */
  SEND_WINDOW_SECONDS?: string;
  PRIVACY_URL?: string;
  /** 別のサイトから fetch で登録 API を呼ぶときに許すオリジン（カンマ区切り） */
  CORS_ORIGINS?: string;
  /** Cloudflare Access：例 example.cloudflareaccess.com と、アプリケーションの AUD タグ */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** "off" でパスワード＋認証アプリのログインを止める（パスキーだけ） */
  ADMIN_PASSWORD_LOGIN?: string;
  BACKUP_KEEP_DAYS?: string;

  // ---- secrets ----
  TOKEN_SECRET?: string;
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_TOTP_SECRET?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** バックアップの暗号化キー（pnpm tsuzuri backup:key で作る TZK1-…） */
  BACKUP_ENCRYPTION_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

/** テストで DB とメール送信を差し替えるための部品 */
export interface WorkerDeps {
  openDb?: (env: Env) => Db & { end?: () => Promise<void> };
  provider?: (env: Env) => MailProvider;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  fetch?: (req: Request) => Promise<Response>;
}

export const NIGHTLY_CRON = "0 18 * * *";

const log = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...(extra ?? {}) }));

function required(env: Env, name: keyof Env): string {
  const v = env[name];
  if (typeof v !== "string" || !v) throw new Error(`${name} が設定されていません`);
  return v;
}

function aws(env: Env, deps: WorkerDeps): AwsHttp | undefined {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return undefined;
  return new AwsHttp({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION ?? "ap-northeast-1",
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

interface Invocation {
  ctx: AppContext;
  /** 応答のあとも続ける処理（確認メールの送信など）。終わってから DB の接続を閉じる */
  tasks: Promise<unknown>[];
  close(): Promise<void>;
}

async function openInvocation(env: Env, deps: WorkerDeps): Promise<Invocation> {
  const secret = required(env, "TOKEN_SECRET");
  if (secret.length < 32) throw new Error("TOKEN_SECRET は 32 文字以上にしてください");
  const publicBaseUrl = required(env, "PUBLIC_BASE_URL").replace(/\/$/, "");
  let db: Db & { end?: () => Promise<void> };
  if (deps.openDb) db = deps.openDb(env);
  else {
    if (!env.HYPERDRIVE?.connectionString) throw new Error("HYPERDRIVE（Supabase への接続）が設定されていません");
    db = pgDb(env.HYPERDRIVE.connectionString, { max: 5 });
  }
  const a = aws(env, deps);
  const provider: MailProvider = deps.provider
    ? deps.provider(env)
    : env.MAIL_PROVIDER === "console" || !a
      ? new ConsoleProvider()
      : new SesHttpProvider(a, env.SES_CONFIGURATION_SET ?? "tsuzuri");
  const payments: PaymentProvider[] = env.STRIPE_WEBHOOK_SECRET ? [new StripePaymentProvider(env.STRIPE_WEBHOOK_SECRET)] : [];
  const now = deps.now ?? (() => new Date());
  const ctx: AppContext = {
    db,
    provider,
    publicBaseUrl,
    ...(env.LINK_BASE_URL ? { linkBaseUrl: env.LINK_BASE_URL.replace(/\/$/, "") } : {}),
    ...(env.ADMIN_BASE_URL ? { adminBaseUrl: env.ADMIN_BASE_URL.replace(/\/$/, "") } : {}),
    secret,
    settings: await loadSettings(db, settingsFromEnv(env as Record<string, string | undefined>)),
    ...(env.FILES ? { storage: new R2FileStorage(env.FILES, publicBaseUrl, secret, now) } : {}),
    ...(env.ADMIN_PASSWORD_HASH && env.ADMIN_TOTP_SECRET
      ? { admin: { passwordHash: env.ADMIN_PASSWORD_HASH, totpSecret: env.ADMIN_TOTP_SECRET, passwordLogin: env.ADMIN_PASSWORD_LOGIN !== "off" } }
      : {}),
    ...(a ? { identityStatus: sesHttpIdentityStatus(a) } : {}),
    ...(payments.length ? { payments } : {}),
    ...(env.BACKUPS
      ? {
          backups: {
            bucket: env.BACKUPS,
            ...(env.BACKUP_ENCRYPTION_KEY ? { key: parseTransferKey(env.BACKUP_ENCRYPTION_KEY) } : {}),
            keepDays: Number(env.BACKUP_KEEP_DAYS ?? 30),
          },
        }
      : {}),
    now,
  };
  const tasks: Promise<unknown>[] = [];
  return {
    ctx,
    tasks,
    async close() {
      // 応答のあとの処理が新しい処理を足すことがあるので、空になるまで待つ
      while (tasks.length) await Promise.allSettled(tasks.splice(0));
      await db.end?.();
    },
  };
}

/** 送信待ちのうち、id を指定したものをすぐ送る（確認メールなど）。空なら期限の来たシナリオを進めて送る */
async function sendNow(ctx: AppContext, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    await scheduleDueSteps(ctx);
    await launchDueBroadcasts(ctx);
    ids = await dueQueuedMessages(ctx, 10);
  }
  for (const id of ids) {
    const outcome = await sendMessage(ctx, id).catch((e: unknown) => {
      log("send error", { id, error: e instanceof Error ? e.message : String(e) });
      return "failed";
    });
    if (outcome !== "sent" && outcome !== "not-queued") log("send outcome", { id, outcome });
  }
}

function limiterFor(env: Env): RateLimiter | undefined {
  const bindings: Record<string, RateLimitBinding | undefined> = { signup: env.SIGNUP_LIMITER, login: env.LOGIN_LIMITER, all: env.ALL_LIMITER };
  if (!Object.values(bindings).some(Boolean)) return undefined;
  return async (rule, key) => {
    const b = bindings[rule.name];
    if (!b) return { ok: true };
    const r = await b.limit({ key: `${rule.name}:${key}` });
    return r.success ? { ok: true } : { ok: false, retryAfterSec: Math.ceil(rule.windowMs / 1000) };
  };
}

export function createWorker(deps: WorkerDeps = {}) {
  const store = new AsyncLocalStorage<Invocation>();
  let app: Hono | undefined;

  const buildApp = (env: Env): Hono => {
    const surfaces = new Set((env.SURFACES ?? "public,admin").split(",").map((s) => s.trim()));
    const limiter = limiterFor(env);
    const cors = (env.CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return createApp(async () => store.getStore()!.ctx, {
      enqueue: async (ids) => {
        const inv = store.getStore()!;
        inv.tasks.push(sendNow(inv.ctx, ids));
      },
      ...(env.PRIVACY_URL ? { privacyUrl: env.PRIVACY_URL } : {}),
      ...(limiter ? { rateLimit: { limiter, clientKey: cloudflareClientIp } } : {}),
      surfaces: { public: surfaces.has("public"), admin: surfaces.has("admin") },
      ...(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? { adminGuard: requireAccess({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }) } : {}),
      ...(cors.length ? { corsOrigins: cors } : {}),
    });
  };

  return {
    async fetch(request: Request, env: Env, ec: ExecutionContextLike): Promise<Response> {
      app ??= buildApp(env);
      let inv: Invocation;
      try {
        inv = await openInvocation(env, deps);
      } catch (e) {
        log("startup error", { error: e instanceof Error ? e.message : String(e) });
        return new Response("service unavailable", { status: 503 });
      }
      try {
        return await store.run(inv, () => app!.fetch(request));
      } finally {
        ec.waitUntil(inv.close().catch((e: unknown) => log("close error", { error: e instanceof Error ? e.message : String(e) })));
      }
    },

    async scheduled(event: ScheduledEventLike, env: Env, ec: ExecutionContextLike): Promise<void> {
      const inv = await openInvocation(env, deps);
      const job = (event.cron === NIGHTLY_CRON ? nightly(inv.ctx, env) : everyMinute(inv.ctx, env, deps)).finally(() => inv.close());
      ec.waitUntil(job);
      await job;
    },
  };
}

/** 毎分の処理 */
export async function everyMinute(ctx: AppContext, env: Env, deps: WorkerDeps = {}): Promise<void> {
  const started = Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      log(`${name} error`, { error: e instanceof Error ? e.message : String(e) });
    }
  };
  await step("automations", async () => {
    const r = await runAutomations(ctx);
    if (r.ran > 0) log("automations", r);
  });
  await step("scheduler", async () => {
    const steps = await scheduleDueSteps(ctx);
    const broadcasts = await launchDueBroadcasts(ctx);
    if (steps.length + broadcasts.length > 0) log("scheduled", { steps: steps.length, broadcasts: broadcasts.length });
    const stuck = await stuckSendingCount(ctx);
    if (stuck > 0) log("warning: messages stuck in sending", { count: stuck });
  });
  await step("ses events", () => pollSesEvents(ctx, env, deps));

  // 送信：SES の送信レート（MAX_SEND_RATE 通/秒）を超えないように、決めた時間だけ送る（残りは次の回）
  const rate = Math.max(0.1, Number(env.MAX_SEND_RATE ?? 1));
  const interval = Math.ceil((1000 / rate) * 1.1);
  const windowMs = Math.min(55, Math.max(5, Number(env.SEND_WINDOW_SECONDS ?? 45))) * 1000;
  await step("sender", async () => {
    await refreshSettings(ctx);
    while (Date.now() - started < windowMs) {
      const ids = await dueQueuedMessages(ctx, 50);
      if (ids.length === 0) return;
      for (const id of ids) {
        if (Date.now() - started >= windowMs) return;
        const t = Date.now();
        const outcome = await sendMessage(ctx, id).catch((e: unknown) => {
          log("send error", { id, error: e instanceof Error ? e.message : String(e) });
          return "failed";
        });
        if (outcome !== "sent" && outcome !== "not-queued") log("send outcome", { id, outcome });
        const wait = interval - (Date.now() - t);
        if (wait > 0) await sleep(wait);
      }
    }
  });
}

/** SES のバウンス・苦情（SNS → SQS）を取りに行く。1 回の Cron で最大 100 件 */
async function pollSesEvents(ctx: AppContext, env: Env, deps: WorkerDeps): Promise<void> {
  const a = aws(env, deps);
  if (!a || !env.SES_EVENTS_QUEUE_URL) return;
  const sqs = new SqsHttp(a, env.SES_EVENTS_QUEUE_URL);
  for (let round = 0; round < 10; round++) {
    const messages = await sqs.receive(10, 0);
    if (messages.length === 0) return;
    for (const m of messages) {
      const event = parseSesEventBody(m.body);
      if (event) {
        const outcome = await handleSesEvent(ctx, event);
        if (outcome !== "delivered" && outcome !== "ignored") log("ses event", { outcome });
      } else {
        log("warning: unreadable SES event message");
      }
      // 読めないメッセージも消す（同じものを何度も処理しないため）
      await sqs.delete(m.receiptHandle);
    }
  }
}

/** 毎晩（日本時間 3:00） */
export async function nightly(ctx: AppContext, _env: Env): Promise<void> {
  const day = backupDay(ctx.now());
  try {
    log("scores", { ...(await recomputeAllScores(ctx)) });
  } catch (e) {
    log("scores error", { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    if (ctx.backups?.key) {
      const r = await backupToR2(ctx, ctx.backups.bucket, ctx.backups.key, day);
      const removed = await pruneR2Backups(ctx.backups.bucket, ctx.backups.keepDays, ctx.now());
      log("backup", { manifest: r.manifest, bytes: r.bytes, rows: r.rows, parts: r.parts, removedDays: removed });
    } else {
      log("warning: backup skipped (BACKUPS or BACKUP_ENCRYPTION_KEY is not set)");
    }
  } catch (e) {
    log("backup error", { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    log("pruned", { ...(await pruneOldData(ctx.db, ctx.now())) });
  } catch (e) {
    log("prune error", { error: e instanceof Error ? e.message : String(e) });
  }
}



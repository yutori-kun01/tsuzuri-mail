/**
 * VPS（Xserver VPS など）で動かす本体。1 つのプロセスで次をすべて担当する。
 * - 公開ページと管理画面の HTTP サーバー（127.0.0.1 で待ち受け、前段の Caddy が HTTPS を担当）
 * - 毎分：期限の来たシナリオと一斉配信を「送信待ち」にする
 * - 送信ワーカー：送信待ちを古い順に、SES の送信レート以下の速さで送る
 * - SES のバウンス・苦情：SNS → SQS に溜まったイベントを取りに行く
 * - 毎日 3:00（日本時間）：読者スコアの再計算、バックアップ、古いデータの削除
 *
 * 設定は環境変数（systemd の EnvironmentFile=/etc/tsuzuri/tsuzuri.env）で渡す。docs/vps.md 参照。
 */
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadSettings, refreshSettings, settingsFromEnv, type AppContext } from "../context.js";
import { MIGRATIONS_DIR, migrate, pgDb } from "../db.js";
import { createApp } from "../http/app.js";
import { LocalFileStorage, localBackupWriter, pruneLocalBackups } from "../providers/local.js";
import { ConsoleProvider, SesProvider, sesIdentityStatus } from "../providers/ses.js";
import { exportAll, pruneOldData } from "../services/backup.js";
import { runAutomations } from "../services/automations.js";
import { launchDueBroadcasts } from "../services/broadcasts.js";
import { dueQueuedMessages, stuckSendingCount } from "../services/queue.js";
import { recomputeAllScores } from "../services/scoring.js";
import { sendMessage } from "../services/sending.js";
import { handleSesEvent } from "../services/ses-events.js";
import { scheduleDueSteps } from "../services/sequences.js";
import { parseSesEventBody } from "./ses-events.js";

const env = process.env;

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません`);
  return v;
}

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...(extra ?? {}) }));

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

async function buildContext(): Promise<AppContext> {
  const secret = required("TOKEN_SECRET");
  if (secret.length < 32) throw new Error("TOKEN_SECRET は 32 文字以上にしてください");
  const caFile = env.DATABASE_CA_FILE;
  const ca = caFile ? await readFile(caFile, "utf8") : undefined;
  if (env.DATABASE_CA_SHA256 && !ca) throw new Error("DATABASE_CA_SHA256 を設定した場合は DATABASE_CA_FILE も必要です");
  const db = pgDb(required("DATABASE_URL"), {
    max: Number(env.DATABASE_POOL_MAX ?? 5),
    ...(ca ? { ca } : {}),
    ...(env.DATABASE_CA_SHA256 ? { caSha256: env.DATABASE_CA_SHA256 } : {}),
  });
  // 設定を読む前に DB の構造を最新にする
  if (env.MIGRATE_ON_START !== "false") {
    const applied = await migrate(db, env.MIGRATIONS_DIR ?? MIGRATIONS_DIR);
    if (applied.length) log("migrated", { applied });
  }
  const publicBaseUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");
  const passwordHash = env.ADMIN_PASSWORD_HASH;
  const totpSecret = env.ADMIN_TOTP_SECRET;
  const ses = env.MAIL_PROVIDER === "console" ? undefined : new SESv2Client({ region: env.AWS_REGION ?? "ap-northeast-1" });
  return {
    db,
    // MAIL_PROVIDER=console は送信せずにログへ出す（VPS 上での動作確認用）
    provider: ses ? new SesProvider(ses, env.SES_CONFIGURATION_SET ?? "tsuzuri") : new ConsoleProvider(),
    ...(ses ? { identityStatus: sesIdentityStatus(ses) } : {}),
    publicBaseUrl,
    secret,
    settings: await loadSettings(db, settingsFromEnv(env)),
    ...(env.FILES_DIR ? { storage: new LocalFileStorage(env.FILES_DIR, publicBaseUrl, secret) } : {}),
    ...(passwordHash && totpSecret ? { admin: { passwordHash, totpSecret } } : {}),
    now: () => new Date(),
  };
}

/** 毎分：シナリオと一斉配信を送信待ちにする */
async function schedulerLoop(ctx: AppContext, signal: AbortSignal, wake: () => void): Promise<void> {
  while (!signal.aborted) {
    try {
      const auto = await runAutomations(ctx);
      if (auto.ran > 0) log("automations", auto);
      const steps = await scheduleDueSteps(ctx);
      const broadcasts = await launchDueBroadcasts(ctx);
      if (steps.length + broadcasts.length > 0) {
        log("scheduled", { steps: steps.length, broadcasts: broadcasts.length });
        wake();
      }
      const stuck = await stuckSendingCount(ctx);
      if (stuck > 0) log("warning: messages stuck in sending", { count: stuck });
    } catch (e) {
      log("scheduler error", { error: e instanceof Error ? e.message : String(e) });
    }
    await sleep(60_000, signal);
  }
}

/** 送信ワーカー：SES の送信レート（MAX_SEND_RATE 通/秒）を超えないように 1 通ずつ送る */
async function senderLoop(ctx: AppContext, signal: AbortSignal, waitForWork: (ms: number) => Promise<void>): Promise<void> {
  const rate = Math.max(0.1, Number(env.MAX_SEND_RATE ?? 1));
  const interval = Math.ceil((1000 / rate) * 1.1);
  while (!signal.aborted) {
    let ids: string[] = [];
    try {
      await refreshSettings(ctx);
      ids = await dueQueuedMessages(ctx, 50);
    } catch (e) {
      log("sender error", { error: e instanceof Error ? e.message : String(e) });
    }
    if (ids.length === 0) {
      await waitForWork(15_000);
      continue;
    }
    for (const id of ids) {
      if (signal.aborted) break;
      const started = Date.now();
      try {
        const outcome = await sendMessage(ctx, id);
        if (outcome !== "sent" && outcome !== "not-queued") log("send outcome", { id, outcome });
      } catch (e) {
        log("send error", { id, error: e instanceof Error ? e.message : String(e) });
      }
      const wait = interval - (Date.now() - started);
      if (wait > 0) await sleep(wait, signal);
    }
  }
}

/** SES のイベント（SNS → SQS）を取りに行く */
async function sesEventsLoop(ctx: AppContext, signal: AbortSignal): Promise<void> {
  const queueUrl = env.SES_EVENTS_QUEUE_URL;
  if (!queueUrl) {
    log("warning: SES_EVENTS_QUEUE_URL is not set; bounces and complaints are not processed");
    return;
  }
  const sqs = new SQSClient({ region: env.AWS_REGION ?? "ap-northeast-1" });
  while (!signal.aborted) {
    try {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }), {
        abortSignal: signal,
      });
      for (const m of r.Messages ?? []) {
        const event = m.Body ? parseSesEventBody(m.Body) : undefined;
        if (event) {
          const outcome = await handleSesEvent(ctx, event);
          if (outcome !== "delivered" && outcome !== "ignored") log("ses event", { outcome });
        }
        // 読めないメッセージも消す（同じものを何度も処理しないため。読めない理由はログに残す）
        if (!event) log("warning: unreadable SES event message");
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
      }
    } catch (e) {
      if (signal.aborted) break;
      log("ses events error", { error: e instanceof Error ? e.message : String(e) });
      await sleep(10_000, signal);
    }
  }
}

/** 毎日 3:00（日本時間）：スコア、バックアップ、古いデータの削除 */
async function nightlyLoop(ctx: AppContext, signal: AbortSignal): Promise<void> {
  let lastRun = "";
  while (!signal.aborted) {
    const jst = new Date(Date.now() + 9 * 3_600_000);
    const day = jst.toISOString().slice(0, 10);
    if (jst.getUTCHours() === 3 && lastRun !== day) {
      lastRun = day;
      try {
        const scores = await recomputeAllScores(ctx);
        log("scores", { ...scores });
        if (env.BACKUP_DIR) {
          const counts = await exportAll(ctx.db, localBackupWriter(env.BACKUP_DIR, day), ctx.now());
          const removed = await pruneLocalBackups(env.BACKUP_DIR, Number(env.BACKUP_KEEP_DAYS ?? 30), ctx.now());
          log("backup", { ...counts, removedDays: removed });
        }
        log("pruned", { ...(await pruneOldData(ctx.db, ctx.now())) });
      } catch (e) {
        log("nightly error", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    await sleep(60_000, signal);
  }
}

async function main(): Promise<void> {
  const ctx = await buildContext();

  const controller = new AbortController();
  const { signal } = controller;

  // 確認メールなどは、送信ワーカーをすぐ起こして送る
  let wakeUp: (() => void) | undefined;
  const wake = () => wakeUp?.();
  const waitForWork = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wakeUp = undefined;
        resolve();
      }
      wakeUp = done;
      signal.addEventListener("abort", done);
    });

  // 登録確定の直後などは、毎分の定期処理を待たずにシナリオを進めて送信ワーカーを起こす
  let kicking = false;
  const kick = async () => {
    if (kicking) return wake();
    kicking = true;
    try {
      await scheduleDueSteps(ctx);
      await launchDueBroadcasts(ctx);
    } finally {
      kicking = false;
    }
    wake();
  };

  const app = createApp(async () => ctx, {
    enqueue: async (ids) => (ids.length ? wake() : kick()),
    rateLimit: true,
    ...(env.PRIVACY_URL ? { privacyUrl: env.PRIVACY_URL } : {}),
  });
  const port = Number(env.PORT ?? 8787);
  const server = serve({ fetch: app.fetch, port, hostname: env.HOST ?? "127.0.0.1" });
  log("listening", { port, admin: Boolean(ctx.admin), files: Boolean(env.FILES_DIR), backups: Boolean(env.BACKUP_DIR) });

  const loops = Promise.all([
    schedulerLoop(ctx, signal, wake),
    senderLoop(ctx, signal, waitForWork),
    sesEventsLoop(ctx, signal),
    nightlyLoop(ctx, signal),
  ]);

  const shutdown = async (sig: string) => {
    log("shutting down", { sig });
    controller.abort();
    server.close();
    // 送信中の 1 通が終わるまで待つ（最大 20 秒）
    await Promise.race([loops, new Promise((r) => setTimeout(r, 20_000))]);
    await (ctx.db as unknown as { end?: () => Promise<void> }).end?.();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

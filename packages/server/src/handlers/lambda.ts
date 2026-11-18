import type { Handler, SNSEvent, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { gzipSync } from "node:zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { handle } from "hono/aws-lambda";
import { createApp } from "../http/app.js";
import { refreshSettings } from "../context.js";
import { enqueue, lambdaContext } from "../runtime.js";
import { exportAll, pruneOldData } from "../services/backup.js";
import { launchDueBroadcasts } from "../services/broadcasts.js";
import { recomputeAllScores } from "../services/scoring.js";
import { sendMessage } from "../services/sending.js";
import { handleSesEvent, type SesEvent } from "../services/ses-events.js";
import { scheduleDueSteps } from "../services/sequences.js";
import { staleQueuedMessages } from "../services/tracking.js";
import { runAutomations } from "../services/automations.js";

/** 公開 HTTP（フォーム、確認、配信停止、計測、Web 版） */
export const api = handle(
  createApp(lambdaContext, {
    enqueue: (ids) => (ids.length ? enqueue(ids) : Promise.resolve()),
    ...(process.env.PRIVACY_URL ? { privacyUrl: process.env.PRIVACY_URL } : {}),
  }),
);

/** 毎分：期限の来たシナリオと一斉配信を送信キューへ */
export const scheduler: Handler = async () => {
  const ctx = await lambdaContext();
  await refreshSettings(ctx);
  await runAutomations(ctx);
  const steps = await scheduleDueSteps(ctx);
  const broadcasts = await launchDueBroadcasts(ctx);
  const stale = await staleQueuedMessages(ctx);
  const ids = [...new Set([...steps, ...broadcasts, ...stale])];
  await enqueue(ids);
  return { steps: steps.length, broadcasts: broadcasts.length, requeued: stale.length };
};

/** 送信キューの消費。再試行すべきものだけ失敗として返す */
export const sender = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const ctx = await lambdaContext();
  // 管理画面で変えた送信者表示などを反映する
  await refreshSettings(ctx);
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  // SES の送信レート上限を超えないよう、1 通ごとに間を空ける
  const interval = Number(process.env.SEND_INTERVAL_MS ?? 0);
  for (const r of event.Records) {
    if (interval > 0) await new Promise((ok) => setTimeout(ok, interval));
    try {
      const outcome = await sendMessage(ctx, r.body);
      if (outcome === "retry") batchItemFailures.push({ itemIdentifier: r.messageId });
    } catch (e) {
      console.error("send failed", r.body, e instanceof Error ? e.message : e);
      batchItemFailures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures };
};

/** SES の配信イベント（SNS 経由） */
export const sesEvents = async (event: SNSEvent): Promise<void> => {
  const ctx = await lambdaContext();
  for (const r of event.Records) {
    const outcome = await handleSesEvent(ctx, JSON.parse(r.Sns.Message) as SesEvent);
    if (outcome !== "delivered" && outcome !== "ignored") console.log("ses event", outcome);
  }
};

/** 毎日深夜：読者スコアの再計算、バックアップの書き出し、古い行動履歴の削除 */
export const nightly: Handler = async () => {
  const ctx = await lambdaContext();
  const summary = await recomputeAllScores(ctx);
  console.log("scores", JSON.stringify(summary));

  const bucket = process.env.BACKUP_BUCKET;
  if (bucket) {
    const s3 = new S3Client({});
    const day = ctx.now().toISOString().slice(0, 10);
    const counts = await exportAll(ctx.db, {
      write: async (name, ndjson) => {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `daily/${day}/${name}.ndjson.gz`,
            Body: gzipSync(ndjson),
            ContentType: "application/x-ndjson",
            ContentEncoding: "gzip",
          }),
        );
      },
    }, ctx.now());
    console.log("backup", JSON.stringify(counts));
  }
  const pruned = await pruneOldData(ctx.db, ctx.now());
  console.log("pruned", JSON.stringify(pruned));
  return summary;
};

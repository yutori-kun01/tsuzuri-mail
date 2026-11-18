import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadSettings, settingsFromEnv, type AppContext, type FileStorage } from "./context.js";
import { pgDb } from "./db.js";
import { SesProvider } from "./providers/ses.js";

/**
 * Lambda 実行時の組み立て。秘密値（DB 接続文字列、トークン鍵）は SSM パラメータストアから読む。
 * 環境変数：PARAM_PREFIX、SES_CONFIGURATION_SET、SEND_QUEUE_URL、FILES_BUCKET、PUBLIC_BASE_URL、MAIL_*
 */
let cached: Promise<AppContext> | undefined;

async function readSecrets(
  prefix: string,
): Promise<{ databaseUrl: string; secret: string; ca?: string; admin?: { passwordHash: string; totpSecret: string } }> {
  const ssm = new SSMClient({});
  // database-ca は任意（Supabase など独自の CA を使う DB のときだけ置く）。admin-* が無ければ管理画面は使えない
  const names = [
    `${prefix}database-url`,
    `${prefix}token-secret`,
    `${prefix}database-ca`,
    `${prefix}admin-password-hash`,
    `${prefix}admin-totp-secret`,
  ];
  const r = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const get = (n: string) => {
    const v = r.Parameters?.find((p) => p.Name === n)?.Value;
    if (!v) throw new Error(`SSM parameter ${n} is missing`);
    return v;
  };
  const opt = (n: string) => r.Parameters?.find((p) => p.Name === n)?.Value;
  const ca = opt(names[2]!);
  const passwordHash = opt(names[3]!);
  const totpSecret = opt(names[4]!);
  return {
    databaseUrl: get(names[0]!),
    secret: get(names[1]!),
    ...(ca ? { ca } : {}),
    ...(passwordHash && totpSecret ? { admin: { passwordHash, totpSecret } } : {}),
  };
}

class S3Storage implements FileStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}
  downloadUrl(key: string): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 600 });
  }
}

export function lambdaContext(): Promise<AppContext> {
  cached ??= (async () => {
    const env = process.env;
    const { databaseUrl, secret, ca, admin } = await readSecrets(env.PARAM_PREFIX ?? "/tsuzuri/");
    // 指紋を設定しているのに CA が無い場合は、検証なしで接続を試みず、原因が分かる形で止める
    if (env.DATABASE_CA_SHA256 && !ca) throw new Error("SSM parameter database-ca is missing");
    const db = pgDb(databaseUrl, {
      max: 2,
      ...(ca ? { ca } : {}),
      ...(env.DATABASE_CA_SHA256 ? { caSha256: env.DATABASE_CA_SHA256 } : {}),
    });
    const settings = await loadSettings(db, settingsFromEnv(env));
    return {
      db,
      provider: new SesProvider(new SESv2Client({}), env.SES_CONFIGURATION_SET ?? "tsuzuri"),
      publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
      secret,
      settings,
      ...(admin ? { admin } : {}),
      ...(env.FILES_BUCKET ? { storage: new S3Storage(new S3Client({}), env.FILES_BUCKET) } : {}),
      now: () => new Date(),
    };
  })();
  return cached;
}

/** 送信記録の id を送信キューに積む（10件ずつ） */
export async function enqueue(ids: readonly string[], queueUrl = process.env.SEND_QUEUE_URL): Promise<void> {
  if (ids.length === 0) return;
  if (!queueUrl) throw new Error("SEND_QUEUE_URL is not set");
  const sqs = new SQSClient({});
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const r = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((id, j) => ({ Id: String(j), MessageBody: id })),
      }),
    );
    if (r.Failed && r.Failed.length > 0) throw new Error(`SQS rejected ${r.Failed.length} messages`);
  }
}

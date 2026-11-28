import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { TsuzuriStack } from "../lib/stack.js";
import { TsuzuriVpsStack } from "../lib/vps-stack.js";

const app = new cdk.App();
// 自分の環境の値（ドメインなど）は infra/tsuzuri.local.json に書く（コミットしない）。cdk.json の値より優先する
const localFile = join(dirname(fileURLToPath(import.meta.url)), "..", "tsuzuri.local.json");
const local: Record<string, unknown> = existsSync(localFile) ? (JSON.parse(readFileSync(localFile, "utf8")) as Record<string, unknown>) : {};
const raw = (k: string): unknown => local[`tsuzuri:${k}`] ?? app.node.tryGetContext(`tsuzuri:${k}`);
const ctx = (k: string): string => String(raw(k) ?? "");
/** 配列または「a, b」の文字列で書かれた設定を配列にする */
const ctxList = (k: string): string[] => {
  const v = raw(k);
  const items = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  return items.map((x) => x.trim().toLowerCase()).filter(Boolean);
};

// 個人情報（返信先・通知先メールなど）はリポジトリに書かず、デプロイ時の環境変数で渡す
const env = process.env;
const stackProps = {
  env: { ...(env.CDK_DEFAULT_ACCOUNT ? { account: env.CDK_DEFAULT_ACCOUNT } : {}), region: "ap-northeast-1" },
};

// tsuzuri:hosting = "vps"（Xserver VPS などで動かす。AWS は SES まわりだけ）| "lambda"（AWS Lambda で動かす）
if (ctx("hosting") === "lambda") {
  new TsuzuriStack(
    app,
    "Tsuzuri",
    {
      domain: ctx("domain"),
      sendingSubdomain: ctx("sendingSubdomain"),
      manageIdentity: ctx("manageIdentity") === "true",
      maxSendRate: Number(ctx("maxSendRate") || 1),
      publicHost: ctx("publicHost"),
      fromLocalPart: ctx("fromLocalPart"),
      paramPrefix: ctx("paramPrefix"),
      databaseCaSha256: ctx("databaseCaSha256"),
      fromName: env.TSUZURI_FROM_NAME ?? "",
      replyTo: env.TSUZURI_REPLY_TO ?? "",
      privacyUrl: env.TSUZURI_PRIVACY_URL ?? "",
      alertEmail: env.TSUZURI_ALERT_EMAIL ?? "",
    },
    { ...stackProps, description: "tsuzuri-mail: newsletter and step mail on SES (Lambda hosting)" },
  );
} else {
  new TsuzuriVpsStack(
    app,
    "TsuzuriVps",
    {
      domain: ctx("domain"),
      sendingSubdomain: ctx("sendingSubdomain"),
      manageIdentity: ctx("manageIdentity") === "true",
      vpsIp: env.TSUZURI_VPS_IP ?? "",
      vpsIpv6: env.TSUZURI_VPS_IPV6 ?? "",
      // 既定はサンドボックス中（true）。本番承認後に cdk.json の tsuzuri:sesSandbox を false にする
      sesSandbox: ctx("sesSandbox") !== "false",
      // シナリオごとに別のドメインから送るときの、追加の送信ドメイン（例 ["news.example.jp"]）
      extraSendingDomains: ctxList("extraSendingDomains"),
      alertEmail: env.TSUZURI_ALERT_EMAIL ?? "",
      // Cloudflare Workers に移すとき：tsuzuri:workersUser を true にして Workers 用の IAM ユーザーを作る。
      // 移行が終わったら tsuzuri:vpsUser を false にして VPS 用を消す
      vpsUser: ctx("vpsUser") !== "false",
      workersUser: ctx("workersUser") === "true",
    },
    { ...stackProps, description: "tsuzuri-mail: SES configuration set, events queue and IAM user for VPS hosting" },
  );
}

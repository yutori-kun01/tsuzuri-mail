import { AwsClient } from "aws4fetch";
import type { MailProvider, OutgoingMessage, SendResult } from "@tsuzuri/core";
import type { IdentityStatus } from "../context.js";
import { formatFrom } from "./from.js";

/**
 * AWS（SES・SQS）を HTTPS で直接呼ぶ（Cloudflare Workers 用。AWS SDK を載せずに済む）。
 * 署名は SigV4（aws4fetch）。鍵は Workers の secret（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY）で渡す。
 * 権限は infra の Workers 用 IAM ユーザーと同じ（SES の送信と ID の読み取り、SES イベントのキューの受信と削除）。
 */
export interface AwsHttpConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** テスト用に差し替える */
  fetch?: (req: Request) => Promise<Response>;
}

export class AwsHttp {
  private readonly client: AwsClient;
  private readonly doFetch: (req: Request) => Promise<Response>;
  constructor(readonly config: AwsHttpConfig) {
    this.client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, retries: 0 });
    this.doFetch = config.fetch ?? ((req) => fetch(req));
  }

  async call(url: string, init: RequestInit & { service: string }): Promise<Response> {
    const { service, ...rest } = init;
    const req = await this.client.sign(url, { ...rest, aws: { service, region: this.config.region } });
    return this.doFetch(req);
  }

  get region(): string {
    return this.config.region;
  }
}

/** AWS のエラー応答から型名を取り出す（"NotFoundException" など） */
async function errorName(res: Response): Promise<string> {
  const header = res.headers.get("x-amzn-errortype") ?? "";
  if (header) return header.split(":")[0]!;
  const body = (await res.json().catch(() => ({}))) as { __type?: string; code?: string };
  const t = body.__type ?? body.code ?? "";
  return t.includes("#") ? t.slice(t.indexOf("#") + 1) : t || `HTTP ${res.status}`;
}

function tagValue(v: string): string {
  return v.replace(/[^A-Za-z0-9_\-.@]/g, "_").slice(0, 256);
}

/** SES（API v2 の SendEmail）で送る。中身は providers/ses.ts の SDK 版と同じ */
export class SesHttpProvider implements MailProvider {
  readonly name = "ses";
  constructor(
    private readonly aws: AwsHttp,
    private readonly configurationSetName: string,
  ) {}

  async send(m: OutgoingMessage): Promise<SendResult> {
    const body = {
      FromEmailAddress: formatFrom(m.from.address, m.from.name),
      Destination: { ToAddresses: [m.to] },
      ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
      ConfigurationSetName: this.configurationSetName,
      Content: {
        Simple: {
          Subject: { Data: m.subject, Charset: "UTF-8" },
          Body: { Html: { Data: m.html, Charset: "UTF-8" }, Text: { Data: m.text, Charset: "UTF-8" } },
          Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
        },
      },
      EmailTags: Object.entries(m.tags ?? {}).map(([Name, Value]) => ({ Name, Value: tagValue(Value) })),
    };
    const res = await this.aws.call(`https://email.${this.aws.region}.amazonaws.com/v2/email/outbound-emails`, {
      service: "ses",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`SES SendEmail failed: ${await errorName(res)}`);
    const r = (await res.json()) as { MessageId?: string };
    if (!r.MessageId) throw new Error("SES returned no MessageId");
    return { providerMessageId: r.MessageId };
  }
}

/** SES の ID の状態（読み取り専用。GetEmailIdentity） */
export function sesHttpIdentityStatus(aws: AwsHttp): (domain: string) => Promise<IdentityStatus> {
  return async (domain) => {
    try {
      const res = await aws.call(`https://email.${aws.region}.amazonaws.com/v2/email/identities/${encodeURIComponent(domain)}`, {
        service: "ses",
        method: "GET",
      });
      if (!res.ok) {
        const name = await errorName(res);
        if (name === "NotFoundException" || name === "AccessDeniedException") return { found: false };
        return { found: false, error: name };
      }
      const r = (await res.json()) as {
        VerifiedForSendingStatus?: boolean;
        DkimAttributes?: { Status?: string; Tokens?: string[] };
        MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string };
      };
      return {
        found: true,
        verified: r.VerifiedForSendingStatus === true,
        ...(r.DkimAttributes?.Status ? { dkimStatus: r.DkimAttributes.Status } : {}),
        dkimTokens: r.DkimAttributes?.Tokens ?? [],
        ...(r.MailFromAttributes?.MailFromDomain ? { mailFromDomain: r.MailFromAttributes.MailFromDomain } : {}),
        ...(r.MailFromAttributes?.MailFromDomainStatus ? { mailFromStatus: r.MailFromAttributes.MailFromDomainStatus } : {}),
      };
    } catch (e) {
      return { found: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export interface QueueMessage {
  body: string;
  receiptHandle: string;
}

/** SQS（JSON プロトコル）。SES のイベント（SNS → SQS）を取りに行くためだけに使う */
export class SqsHttp {
  constructor(
    private readonly aws: AwsHttp,
    private readonly queueUrl: string,
  ) {}

  private async target(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.aws.call(`https://sqs.${this.aws.region}.amazonaws.com/`, {
      service: "sqs",
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `AmazonSQS.${action}` },
      body: JSON.stringify({ QueueUrl: this.queueUrl, ...payload }),
    });
    if (!res.ok) throw new Error(`SQS ${action} failed: ${await errorName(res)}`);
    return res.json();
  }

  async receive(max = 10, waitSeconds = 0): Promise<QueueMessage[]> {
    const r = (await this.target("ReceiveMessage", { MaxNumberOfMessages: max, WaitTimeSeconds: waitSeconds })) as {
      Messages?: { Body?: string; ReceiptHandle?: string }[];
    };
    return (r.Messages ?? []).filter((m) => m.ReceiptHandle).map((m) => ({ body: m.Body ?? "", receiptHandle: m.ReceiptHandle! }));
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.target("DeleteMessage", { ReceiptHandle: receiptHandle });
  }
}

import { GetEmailIdentityCommand, SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import type { MailProvider, OutgoingMessage, SendResult } from "@tsuzuri/core";
import type { IdentityStatus } from "../context.js";

/** 表示名に ASCII 以外を含む場合は RFC 2047 の encoded-word にする（SES の要件） */
export function formatFrom(address: string, name?: string): string {
  if (!name) return address;
  const ascii = /^[\x20-\x7e]*$/.test(name);
  const display = ascii ? `"${name.replace(/["\\]/g, "\\$&")}"` : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
  return `${display} <${address}>`;
}

/** SES のタグ値に使えない文字を置き換える */
function tagValue(v: string): string {
  return v.replace(/[^A-Za-z0-9_\-.@]/g, "_").slice(0, 256);
}

export class SesProvider implements MailProvider {
  readonly name = "ses";
  constructor(
    private readonly client: SESv2Client,
    private readonly configurationSetName: string,
  ) {}

  async send(m: OutgoingMessage): Promise<SendResult> {
    const r = await this.client.send(
      new SendEmailCommand({
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
      }),
    );
    if (!r.MessageId) throw new Error("SES returned no MessageId");
    return { providerMessageId: r.MessageId };
  }
}

/** ローカル開発用：送らずに標準出力へ要約を出す（宛先は伏せる） */
export class ConsoleProvider implements MailProvider {
  readonly name = "console";
  async send(m: OutgoingMessage): Promise<SendResult> {
    console.log(`[mail] ${m.idempotencyKey} subject="${m.subject}"\n${m.text}\n`);
    return { providerMessageId: `console-${m.idempotencyKey}` };
  }
}

/** SES の ID の状態を読む（管理画面の「送信ドメイン」用。GetEmailIdentity だけを使う読み取り専用） */
export function sesIdentityStatus(client: SESv2Client): (domain: string) => Promise<IdentityStatus> {
  return async (domain) => {
    try {
      const r = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      return {
        found: true,
        verified: r.VerifiedForSendingStatus === true,
        ...(r.DkimAttributes?.Status ? { dkimStatus: r.DkimAttributes.Status } : {}),
        dkimTokens: r.DkimAttributes?.Tokens ?? [],
        ...(r.MailFromAttributes?.MailFromDomain ? { mailFromDomain: r.MailFromAttributes.MailFromDomain } : {}),
        ...(r.MailFromAttributes?.MailFromDomainStatus ? { mailFromStatus: r.MailFromAttributes.MailFromDomainStatus } : {}),
      };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "NotFoundException") return { found: false };
      // 権限が無い（tsuzuri.local.json に足していない＝デプロイ前）ときも、まだ AWS 側に無いのと同じ扱いにする
      if (name === "AccessDeniedException") return { found: false };
      return { found: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

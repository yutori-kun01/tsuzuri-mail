/**
 * 送信プロバイダの差し替え口。SES 以外（別の送信サービス、将来の LINE）もこれを実装する。
 * アプリ側はこのインターフェース越しにだけ送信する。
 */
export interface OutgoingMessage {
  /** messages.idempotency_key と同じ値。プロバイダ側でも重複送信の抑止に使う */
  idempotencyKey: string;
  to: string;
  from: { address: string; name?: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** 配信イベント（バウンス等）と送信記録を結び付けるタグ */
  tags?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
}

export interface MailProvider {
  readonly name: string;
  send(message: OutgoingMessage): Promise<SendResult>;
}

/** 開発用：実際には送らず記録だけする */
export class MemoryProvider implements MailProvider {
  readonly name = "memory";
  readonly sent: OutgoingMessage[] = [];
  async send(message: OutgoingMessage): Promise<SendResult> {
    this.sent.push(message);
    return { providerMessageId: `memory-${this.sent.length}` };
  }
}

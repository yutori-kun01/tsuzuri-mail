/**
 * 決済サービスとのやりとりの型。送信の MailProvider と同じく、決済サービス固有の処理はこの型の実装の中に閉じ込める。
 * サーバー側は PaymentEvent だけを見て注文を記録する。カード情報は扱わない（決済サービスの画面で入力してもらう）。
 */
export type PaymentEvent =
  | {
      kind: "paid";
      eventId: string;
      eventType: string;
      /** 注文の id（Stripe：Checkout Session の id） */
      orderRef: string;
      /** 支払いの id（Stripe：PaymentIntent の id。返金の通知と結びつける） */
      paymentRef?: string;
      /** 商品の code（決済サービス側のメタデータ tsuzuri_product） */
      productCode?: string;
      email?: string;
      name?: string;
      amount: number;
      currency: string;
      /** 購入画面で「お知らせを受け取る」に同意したか */
      marketingOptIn: boolean;
      occurredAt: Date;
    }
  | {
      kind: "refunded";
      eventId: string;
      eventType: string;
      paymentRef: string;
      /** 返金された合計（最小単位） */
      amountRefunded: number;
      /** 全額の返金か */
      full: boolean;
      occurredAt: Date;
    }
  | { kind: "ignored"; eventId: string; eventType: string };

export class PaymentSignatureError extends Error {}

export interface PaymentProvider {
  readonly name: string;
  /** 通知の署名を確かめて読む。署名が正しくないときは PaymentSignatureError */
  parseWebhook(rawBody: string, headers: (name: string) => string | undefined, now: Date): Promise<PaymentEvent>;
}

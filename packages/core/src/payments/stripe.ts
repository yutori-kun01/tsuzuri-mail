import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentSignatureError, type PaymentEvent, type PaymentProvider } from "./provider.js";

/**
 * Stripe の Webhook。署名（Stripe-Signature ヘッダー）を確かめ、次の通知だけを読む。
 * - checkout.session.completed（支払い済みのとき）／checkout.session.async_payment_succeeded（コンビニ払いなどの入金）
 * - charge.refunded（返金）
 * それ以外は ignored。Stripe の SDK は使わない（署名は HMAC-SHA256 で、仕様が公開されている）。
 */

/** 署名の時刻と今のずれの上限（秒）。古い通知の再送り込みを防ぐ */
export const STRIPE_TOLERANCE_SEC = 300;

export function stripeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** テスト・動作確認用：Stripe と同じ形のヘッダーを作る */
export function stripeSignatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${stripeSignature(secret, timestamp, rawBody)}`;
}

export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, now: Date, toleranceSec = STRIPE_TOLERANCE_SEC): void {
  if (!header) throw new PaymentSignatureError("missing signature");
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x.trim());
    if (k === "t" && v) t = Number(v);
    if (k === "v1" && v) v1.push(v);
  }
  if (t === undefined || !Number.isFinite(t) || v1.length === 0) throw new PaymentSignatureError("malformed signature");
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSec) throw new PaymentSignatureError("signature timestamp out of tolerance");
  const expected = Buffer.from(stripeSignature(secret, t, rawBody));
  const ok = v1.some((s) => {
    const actual = Buffer.from(s);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!ok) throw new PaymentSignatureError("signature mismatch");
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

export function parseStripeEvent(rawBody: string): PaymentEvent {
  let e: Obj;
  try {
    e = obj(JSON.parse(rawBody));
  } catch {
    throw new PaymentSignatureError("body is not JSON");
  }
  const eventId = str(e.id) ?? "";
  const eventType = str(e.type) ?? "";
  if (!eventId || !eventType) throw new PaymentSignatureError("not a Stripe event");
  const o = obj(obj(e.data).object);
  const occurredAt = new Date(num(e.created) * 1000 || Date.now());

  if (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded") {
    const paid = str(o.payment_status) === "paid" || str(o.payment_status) === "no_payment_required";
    // コンビニ払いなどは completed の時点では未入金。入金の通知（async_payment_succeeded）を待つ
    if (!paid) return { kind: "ignored", eventId, eventType };
    const details = obj(o.customer_details);
    const email = str(details.email) ?? str(o.customer_email);
    const name = str(details.name);
    const productCode = str(obj(o.metadata).tsuzuri_product);
    const paymentRef = str(o.payment_intent);
    return {
      kind: "paid",
      eventId,
      eventType,
      orderRef: str(o.id) ?? "",
      ...(paymentRef ? { paymentRef } : {}),
      ...(productCode ? { productCode } : {}),
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      amount: num(o.amount_total),
      currency: (str(o.currency) ?? "jpy").toLowerCase(),
      marketingOptIn: str(obj(o.consent).promotions) === "opt_in",
      occurredAt,
    };
  }
  if (eventType === "charge.refunded") {
    const paymentRef = str(o.payment_intent);
    if (!paymentRef) return { kind: "ignored", eventId, eventType };
    const amount = num(o.amount);
    const amountRefunded = num(o.amount_refunded);
    return { kind: "refunded", eventId, eventType, paymentRef, amountRefunded, full: o.refunded === true || (amount > 0 && amountRefunded >= amount), occurredAt };
  }
  return { kind: "ignored", eventId, eventType };
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  constructor(private readonly webhookSecret: string) {
    if (!webhookSecret) throw new Error("Stripe webhook secret is empty");
  }

  async parseWebhook(rawBody: string, headers: (name: string) => string | undefined, now: Date): Promise<PaymentEvent> {
    verifyStripeSignature(rawBody, headers("stripe-signature"), this.webhookSecret, now);
    const ev = parseStripeEvent(rawBody);
    if (ev.kind === "paid" && !ev.orderRef) return { kind: "ignored", eventId: ev.eventId, eventType: ev.eventType };
    return ev;
  }
}

import { describe, expect, it } from "vitest";
import { PaymentSignatureError } from "./provider.js";
import { parseStripeEvent, StripePaymentProvider, stripeSignatureHeader, verifyStripeSignature } from "./stripe.js";

const SECRET = "whsec_test_" + "x".repeat(24);
const now = new Date("2026-11-28T00:00:00Z");
const t = Math.floor(now.getTime() / 1000);

const session = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    created: t,
    data: {
      object: {
        id: "cs_test_1",
        payment_status: "paid",
        payment_intent: "pi_1",
        amount_total: 3000,
        currency: "JPY",
        customer_details: { email: "buyer@example.com", name: "読者" },
        metadata: { tsuzuri_product: "course-a" },
        consent: { promotions: "opt_in" },
        ...over,
      },
    },
  });

describe("Stripe の署名", () => {
  it("正しい署名を受け付け、違う・古い・形の崩れた署名を拒む", () => {
    const body = session();
    expect(() => verifyStripeSignature(body, stripeSignatureHeader(SECRET, t, body), SECRET, now)).not.toThrow();
    // 複数の v1（鍵の入れ替え中）はどれか 1 つ合えばよい
    expect(() => verifyStripeSignature(body, `t=${t},v1=deadbeef,${stripeSignatureHeader(SECRET, t, body).split(",")[1]}`, SECRET, now)).not.toThrow();
    expect(() => verifyStripeSignature(body, stripeSignatureHeader("whsec_other_secret_value_000", t, body), SECRET, now)).toThrow(PaymentSignatureError);
    expect(() => verifyStripeSignature(body + " ", stripeSignatureHeader(SECRET, t, body), SECRET, now)).toThrow(PaymentSignatureError);
    expect(() => verifyStripeSignature(body, stripeSignatureHeader(SECRET, t - 301, body), SECRET, now)).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(body, undefined, SECRET, now)).toThrow(PaymentSignatureError);
    expect(() => verifyStripeSignature(body, "garbage", SECRET, now)).toThrow(PaymentSignatureError);
  });
});

describe("Stripe の通知を読む", () => {
  it("支払い済みの Checkout を注文として読む", () => {
    expect(parseStripeEvent(session())).toEqual({
      kind: "paid",
      eventId: "evt_1",
      eventType: "checkout.session.completed",
      orderRef: "cs_test_1",
      paymentRef: "pi_1",
      productCode: "course-a",
      email: "buyer@example.com",
      name: "読者",
      amount: 3000,
      currency: "jpy",
      marketingOptIn: true,
      occurredAt: now,
    });
  });

  it("未入金（コンビニ払いの受付）は無視し、入金の通知で注文にする", () => {
    expect(parseStripeEvent(session({ payment_status: "unpaid" })).kind).toBe("ignored");
    const paid = parseStripeEvent(session().replace("checkout.session.completed", "checkout.session.async_payment_succeeded"));
    expect(paid.kind).toBe("paid");
  });

  it("同意が無ければ宣伝メールの同意なしとして読む", () => {
    const ev = parseStripeEvent(session({ consent: null }));
    expect(ev.kind === "paid" && ev.marketingOptIn).toBe(false);
  });

  it("返金を読む（全額か一部か）", () => {
    const refund = (amountRefunded: number, refunded: boolean) =>
      JSON.stringify({ id: "evt_2", type: "charge.refunded", created: t, data: { object: { payment_intent: "pi_1", amount: 3000, amount_refunded: amountRefunded, refunded } } });
    expect(parseStripeEvent(refund(3000, true))).toMatchObject({ kind: "refunded", paymentRef: "pi_1", full: true, amountRefunded: 3000 });
    expect(parseStripeEvent(refund(1000, false))).toMatchObject({ kind: "refunded", full: false });
  });

  it("関係ない通知は ignored", () => {
    expect(parseStripeEvent(JSON.stringify({ id: "evt_3", type: "customer.created", data: { object: {} } }))).toEqual({
      kind: "ignored",
      eventId: "evt_3",
      eventType: "customer.created",
    });
  });

  it("プロバイダは署名を確かめてから読む", async () => {
    const p = new StripePaymentProvider(SECRET);
    const body = session();
    const ok = await p.parseWebhook(body, (n) => (n === "stripe-signature" ? stripeSignatureHeader(SECRET, t, body) : undefined), now);
    expect(ok.kind).toBe("paid");
    await expect(p.parseWebhook(body, () => undefined, now)).rejects.toThrow(PaymentSignatureError);
  });
});

import { stripeSignatureHeader, type PaymentEvent } from "@tsuzuri/core";
import { StripePaymentProvider } from "@tsuzuri/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { runAutomations } from "../src/services/automations.js";
import { handlePaymentEvent } from "../src/services/commerce.js";
import { scheduleDueSteps } from "../src/services/sequences.js";
import { sendMessage } from "../src/services/sending.js";
import { recordDownload } from "../src/services/tracking.js";
import { unsubscribe } from "../src/services/subscription.js";
import { createEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let productId: string;
let sequenceId: string;

const paid = (over: Partial<Extract<PaymentEvent, { kind: "paid" }>> = {}): PaymentEvent => ({
  kind: "paid",
  eventId: "evt_1",
  eventType: "checkout.session.completed",
  orderRef: "cs_1",
  paymentRef: "pi_1",
  productCode: "course-a",
  email: "Buyer@Example.com",
  name: "購入者",
  amount: 3000,
  currency: "jpy",
  marketingOptIn: false,
  occurredAt: new Date("2026-11-13T00:00:00Z"),
  ...over,
});

async function contactOf(email: string) {
  const [c] = await env.ctx.db.query<{ id: string; status: string; source: string }>(
    "SELECT c.id, c.status, c.source FROM contacts c JOIN channels ch ON ch.contact_id = c.id WHERE ch.address = $1",
    [email],
  );
  return c;
}

/** シナリオを進めて、送信待ちを全部送る */
async function runSends(): Promise<void> {
  await scheduleDueSteps(env.ctx);
  const ids = await env.ctx.db.query<{ id: string }>("SELECT id FROM messages WHERE status = 'queued'");
  for (const { id } of ids) await sendMessage(env.ctx, id);
}

beforeEach(async () => {
  env = await createEnv();
  const db = env.ctx.db;
  [{ id: sequenceId }] = (await db.query<{ id: string }>(
    "INSERT INTO sequences (slug, name, status, purpose) VALUES ('course-a', '講座のお届け', 'active', 'product') RETURNING id",
  )) as [{ id: string }];
  await db.query("INSERT INTO sequence_steps (sequence_id, position, subject, body_markdown, delay_minutes) VALUES ($1, 1, 'ご購入ありがとうございます', '講座：%download%', 0)", [
    sequenceId,
  ]);
  const [tag] = await db.query<{ id: string }>("INSERT INTO tags (name, category) VALUES ('購入:講座', 'cust') RETURNING id");
  [{ id: productId }] = (await db.query<{ id: string }>(
    "INSERT INTO products (code, name, status, sequence_id, tag_id, delivery_key) VALUES ('course-a', '講座', 'active', $1, $2, 'products/course-a.pdf') RETURNING id",
    [sequenceId, tag!.id],
  )) as [{ id: string }];
});

describe("決済の通知から商品のメールまで", () => {
  it("購入者を確認待ちの読者として作り、商品のシナリオだけを届ける", async () => {
    expect(await handlePaymentEvent(env.ctx, "stripe", paid())).toBe("processed");
    const c = await contactOf("buyer@example.com");
    expect(c).toMatchObject({ status: "pending", source: "purchase:course-a" });
    const [order] = await env.ctx.db.query<{ status: string; amount: number; contact_id: string }>("SELECT status, amount, contact_id FROM orders");
    expect(order).toMatchObject({ status: "paid", amount: 3000, contact_id: c!.id });
    // 注文にはメールアドレスを持たせない
    expect(Object.keys((await env.ctx.db.query("SELECT * FROM orders"))[0]!)).not.toContain("email");
    const tags = await env.ctx.db.query<{ name: string }>("SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1", [c!.id]);
    expect(tags.map((t) => t.name)).toEqual(["購入:講座"]);

    await runSends();
    expect(env.provider.sent.map((m) => m.subject)).toEqual(["ご購入ありがとうございます"]);
    // 商品のファイルのリンク（p:<商品>）が入り、受け取る権利がある間だけ配る
    const link = /\/d\/([A-Za-z0-9._-]+)/.exec(env.provider.sent[0]!.text)![1]!;
    expect(await recordDownload(env.ctx, link, { method: "GET", userAgent: undefined })).toBe("https://files.example.com/products/course-a.pdf?sig=1");
  });

  it("同じ通知・同じ注文は 1 回だけ処理する", async () => {
    expect(await handlePaymentEvent(env.ctx, "stripe", paid())).toBe("processed");
    expect(await handlePaymentEvent(env.ctx, "stripe", paid())).toBe("duplicate");
    // 別の通知でも同じ注文（Checkout Session）なら 1 行のまま
    expect(await handlePaymentEvent(env.ctx, "stripe", paid({ eventId: "evt_other", eventType: "checkout.session.async_payment_succeeded" }))).toBe("duplicate");
    expect((await env.ctx.db.query("SELECT 1 FROM orders")).length).toBe(1);
    expect((await env.ctx.db.query("SELECT 1 FROM entitlements")).length).toBe(1);
  });

  it("購入画面でお知らせに同意した人は配信中の読者になる（同意の記録つき）", async () => {
    await handlePaymentEvent(env.ctx, "stripe", paid({ marketingOptIn: true }));
    const c = await contactOf("buyer@example.com");
    expect(c!.status).toBe("active");
    const [consent] = await env.ctx.db.query<{ method: string; confirmed_at: Date | null }>("SELECT method, confirmed_at FROM consents");
    expect(consent!.method).toBe("purchase");
    expect(consent!.confirmed_at).not.toBeNull();
  });

  it("配信を停止した人には、商品のメールも送らない（同意しても自動では戻さない）", async () => {
    await handlePaymentEvent(env.ctx, "stripe", paid());
    const c = await contactOf("buyer@example.com");
    await unsubscribe(env.ctx, c!.id);
    await handlePaymentEvent(env.ctx, "stripe", paid({ eventId: "evt_2", orderRef: "cs_2", paymentRef: "pi_2", marketingOptIn: true }));
    expect((await contactOf("buyer@example.com"))!.status).toBe("unsubscribed");
    await runSends();
    expect(env.provider.sent).toEqual([]);
  });

  it("全額の返金で受け取る権利を止め、商品のシナリオとファイルも止める", async () => {
    await handlePaymentEvent(env.ctx, "stripe", paid());
    await runSends();
    const link = /\/d\/([A-Za-z0-9._-]+)/.exec(env.provider.sent[0]!.text)![1]!;
    const refund: PaymentEvent = { kind: "refunded", eventId: "evt_r", eventType: "charge.refunded", paymentRef: "pi_1", amountRefunded: 3000, full: true, occurredAt: new Date() };
    expect(await handlePaymentEvent(env.ctx, "stripe", refund)).toBe("processed");
    expect((await env.ctx.db.query<{ status: string }>("SELECT status FROM orders"))[0]!.status).toBe("refunded");
    expect(await recordDownload(env.ctx, link, { method: "GET", userAgent: undefined })).toBeUndefined();
    // 知らない支払いの返金は記録だけ
    expect(await handlePaymentEvent(env.ctx, "stripe", { ...refund, eventId: "evt_r2", paymentRef: "pi_unknown" })).toBe("unknown-order");
  });

  it("一部の返金では権利を残す", async () => {
    await handlePaymentEvent(env.ctx, "stripe", paid());
    await handlePaymentEvent(env.ctx, "stripe", { kind: "refunded", eventId: "evt_r", eventType: "charge.refunded", paymentRef: "pi_1", amountRefunded: 1000, full: false, occurredAt: new Date() });
    expect((await env.ctx.db.query<{ status: string }>("SELECT status FROM orders"))[0]!.status).toBe("partially_refunded");
    expect((await env.ctx.db.query("SELECT 1 FROM entitlements WHERE revoked_at IS NULL")).length).toBe(1);
  });

  it("知らない商品の支払いも注文として残す", async () => {
    expect(await handlePaymentEvent(env.ctx, "stripe", paid({ productCode: "nope" }))).toBe("unknown-product");
    const [o] = await env.ctx.db.query<{ product_id: string | null }>("SELECT product_id FROM orders");
    expect(o!.product_id).toBeNull();
    expect((await env.ctx.db.query<{ outcome: string }>("SELECT outcome FROM payment_events"))[0]!.outcome).toBe("unknown-product");
  });

  it("自動化：商品を買ったときをきっかけに動く", async () => {
    const [seq] = await env.ctx.db.query<{ id: string }>("INSERT INTO sequences (slug, name, status) VALUES ('upsell', '案内', 'active') RETURNING id");
    await env.ctx.db.query(
      "INSERT INTO automation_rules (name, trigger_type, trigger_value, action_type, action_value) VALUES ('r', 'purchased', $1, 'add_tag', '購入者')",
      [productId],
    );
    await handlePaymentEvent(env.ctx, "stripe", paid({ occurredAt: env.ctx.now() }));
    env.setNow(new Date(env.ctx.now().getTime() + 60_000));
    expect((await runAutomations(env.ctx)).ran).toBe(1);
    const tags = await env.ctx.db.query<{ name: string }>("SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id ORDER BY t.name");
    expect(tags.map((t) => t.name)).toContain("購入者");
    expect(seq).toBeTruthy();
  });
});

describe("Webhook の受け口と特商法のページ", () => {
  const SECRET = "whsec_test_" + "z".repeat(24);
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    env.ctx.payments = [new StripePaymentProvider(SECRET)];
    app = createApp(async () => env.ctx, { enqueue: async () => {} });
  });

  const hook = (body: string, sig?: string) =>
    app.request("/hooks/stripe", { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) }, body });

  it("署名が正しい通知だけを受け、同じ通知は 2 回目も 200 を返す（送り直しを止めるため）", async () => {
    const t = Math.floor(env.ctx.now().getTime() / 1000);
    const body = JSON.stringify({
      id: "evt_w1",
      type: "checkout.session.completed",
      created: t,
      data: { object: { id: "cs_w1", payment_status: "paid", payment_intent: "pi_w1", amount_total: 3000, currency: "jpy", customer_details: { email: "w@example.com" }, metadata: { tsuzuri_product: "course-a" } } },
    });
    expect((await hook(body)).status).toBe(400);
    expect((await hook(body, stripeSignatureHeader("whsec_wrong_secret_0000000000", t, body))).status).toBe(400);
    expect((await hook(body, stripeSignatureHeader(SECRET, t, body))).status).toBe(200);
    expect((await hook(body, stripeSignatureHeader(SECRET, t, body))).status).toBe(200);
    expect((await env.ctx.db.query("SELECT 1 FROM orders")).length).toBe(1);
    expect((await app.request("/hooks/unknown", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("特商法のページは設定から自動で作る（未設定なら準備中）", async () => {
    expect((await app.request("/legal/commerce")).status).toBe(404);
    env.ctx.settings.commerce = { sellerName: "つづり", disclosureOnRequest: true, returnPolicy: "返品不可" };
    const html = await (await app.request("/legal/commerce")).text();
    expect(html).toContain("特定商取引法に基づく表記");
    expect(html).toContain("つづり");
    expect(html).toContain("請求があった場合には遅滞なく開示いたします。");
    expect(html).toContain("返品不可");
  });
});

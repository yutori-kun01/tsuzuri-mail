import type { PaymentEvent } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import { enroll } from "./sequences.js";
import { normalizeEmail } from "./subscription.js";
export { PRODUCT_ENTITLED_SQL } from "./entitlements.js";

/**
 * 決済の通知（PaymentEvent）を記録して、商品の受け取りにつなげる。
 *
 * - 同じ通知は 1 回だけ処理する（payment_events の一意制約。アプリ側の確認だけに頼らない）。
 * - 同じ注文も 1 行だけ（orders の一意制約）。
 * - 購入した人を読者として持つ（無ければ作る）。購入画面で宣伝メールに同意していない人は status = pending のまま。
 *   pending の人に届くのは「商品のシナリオ」（purpose = product）だけで、メルマガやほかのシナリオは届かない。
 * - 配信停止・苦情・ハードバウンスの人には、商品のメールも送らない（ほかのメールと同じく常に優先）。
 */

export const PURCHASE_CONSENT_VERSION = "checkout-promotions";

export type PaymentOutcome = "processed" | "duplicate" | "ignored" | "unknown-product" | "unknown-order";

interface ProductRow {
  id: string;
  code: string;
  sequence_id: string | null;
  tag_id: string | null;
}

async function findOrCreateBuyer(
  tx: Db,
  ctx: AppContext,
  email: string,
  name: string | undefined,
  source: string,
): Promise<{ contactId: string; channelId: string; contactStatus: string; channelStatus: string }> {
  const [existing] = await tx.query<{ contact_id: string; channel_id: string; contact_status: string; channel_status: string }>(
    `SELECT ch.contact_id, ch.id AS channel_id, c.status AS contact_status, ch.status AS channel_status
       FROM channels ch JOIN contacts c ON c.id = ch.contact_id
      WHERE ch.kind = 'email' AND ch.address = $1 FOR UPDATE`,
    [email],
  );
  if (existing) {
    if (name) await tx.query("UPDATE contacts SET display_name = COALESCE(display_name, $2) WHERE id = $1", [existing.contact_id, name]);
    return { contactId: existing.contact_id, channelId: existing.channel_id, contactStatus: existing.contact_status, channelStatus: existing.channel_status };
  }
  const [c] = await tx.query<{ id: string }>("INSERT INTO contacts (display_name, source, status) VALUES ($1, $2, 'pending') RETURNING id", [
    name ?? null,
    source,
  ]);
  const [ch] = await tx.query<{ id: string }>("INSERT INTO channels (contact_id, kind, address, status) VALUES ($1, 'email', $2, 'active') RETURNING id", [
    c!.id,
    email,
  ]);
  return { contactId: c!.id, channelId: ch!.id, contactStatus: "pending", channelStatus: "active" };
}

async function handlePaid(tx: Db, ctx: AppContext, provider: string, ev: Extract<PaymentEvent, { kind: "paid" }>, eventRowId: string): Promise<PaymentOutcome> {
  const now = ctx.now();
  const [product] = ev.productCode
    ? await tx.query<ProductRow>("SELECT id, code, sequence_id, tag_id FROM products WHERE code = $1", [ev.productCode])
    : [];
  const email = ev.email ? normalizeEmail(ev.email) : undefined;
  const buyer = email ? await findOrCreateBuyer(tx, ctx, email, ev.name, `purchase:${product?.code ?? ev.productCode ?? "unknown"}`) : undefined;

  const [order] = await tx.query<{ id: string }>(
    `INSERT INTO orders (provider, provider_order_id, provider_payment_id, product_id, contact_id, amount, currency, status, marketing_opt_in, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', $8, $9)
     ON CONFLICT (provider, provider_order_id) DO NOTHING RETURNING id`,
    [provider, ev.orderRef, ev.paymentRef ?? null, product?.id ?? null, buyer?.contactId ?? null, ev.amount, ev.currency, ev.marketingOptIn, ev.occurredAt],
  );
  if (!order) return "duplicate";
  await tx.query("UPDATE payment_events SET order_id = $2 WHERE id = $1", [eventRowId, order.id]);
  if (!product) return "unknown-product";
  if (!buyer) return "processed";

  await tx.query("INSERT INTO entitlements (contact_id, product_id, order_id, granted_at) VALUES ($1, $2, $3, $4)", [
    buyer.contactId,
    product.id,
    order.id,
    now,
  ]);
  await tx.query("INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'purchase', $2, $3)", [
    buyer.contactId,
    JSON.stringify({ product: product.code, orderId: order.id }),
    now,
  ]);
  if (product.tag_id) {
    await tx.query("INSERT INTO contact_tags (contact_id, tag_id, reason, tagged_at) VALUES ($1, $2, 'purchase', $3) ON CONFLICT DO NOTHING", [
      buyer.contactId,
      product.tag_id,
      now,
    ]);
  }

  // 購入画面で宣伝メールに同意した人は、確認待ちの読者から配信中の読者にする。
  // 一度配信を停止した人・苦情を出した人は、ここでは戻さない（フォームからの再登録で本人に確かめる）
  if (ev.marketingOptIn) {
    await tx.query(
      "INSERT INTO consents (channel_id, method, consent_text_version, evidence, consented_at, confirmed_at) VALUES ($1, 'purchase', $2, $3, $4, $4)",
      [buyer.channelId, PURCHASE_CONSENT_VERSION, JSON.stringify({ provider, orderId: order.id }), now],
    );
    if (buyer.contactStatus === "pending" && buyer.channelStatus === "active") {
      await tx.query("UPDATE contacts SET status = 'active', updated_at = $2 WHERE id = $1", [buyer.contactId, now]);
      await tx.query("INSERT INTO events (contact_id, type, occurred_at) VALUES ($1, 'subscribe', $2)", [buyer.contactId, now]);
    }
  }

  // 商品のシナリオを始める（配信停止・苦情・バウンスの人には始めない）
  if (product.sequence_id && buyer.contactStatus !== "unsubscribed" && buyer.channelStatus === "active") {
    await enroll(tx, ctx, buyer.contactId, product.sequence_id);
  }
  return "processed";
}

async function handleRefunded(tx: Db, ctx: AppContext, provider: string, ev: Extract<PaymentEvent, { kind: "refunded" }>, eventRowId: string): Promise<PaymentOutcome> {
  const now = ctx.now();
  const [order] = await tx.query<{ id: string; contact_id: string | null; product_id: string | null }>(
    `UPDATE orders SET status = $3, refunded_at = COALESCE(refunded_at, $4), updated_at = $4
      WHERE provider = $1 AND provider_payment_id = $2 RETURNING id, contact_id, product_id`,
    [provider, ev.paymentRef, ev.full ? "refunded" : "partially_refunded", now],
  );
  if (!order) return "unknown-order";
  await tx.query("UPDATE payment_events SET order_id = $2 WHERE id = $1", [eventRowId, order.id]);
  // 一部の返金では受け取る権利を残す（どう扱うかは事業者が決める。全額のときだけ止める）
  if (!ev.full || !order.contact_id) return "processed";
  await tx.query("UPDATE entitlements SET revoked_at = $2 WHERE order_id = $1 AND revoked_at IS NULL", [order.id, now]);
  await tx.query("INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'refund', $2, $3)", [
    order.contact_id,
    JSON.stringify({ orderId: order.id }),
    now,
  ]);
  // ほかの注文でまだ権利があるなら、商品のシナリオは止めない
  const [still] = await tx.query("SELECT 1 FROM entitlements WHERE contact_id = $1 AND product_id = $2 AND revoked_at IS NULL", [
    order.contact_id,
    order.product_id,
  ]);
  if (!still) {
    await tx.query(
      `UPDATE enrollments SET status = 'stopped', updated_at = $3
        WHERE contact_id = $1 AND status = 'active' AND sequence_id = (SELECT sequence_id FROM products WHERE id = $2)`,
      [order.contact_id, order.product_id, now],
    );
    await tx.query(
      `UPDATE messages SET status = 'skipped', error = 'refunded'
        WHERE contact_id = $1 AND status = 'queued'
          AND step_id IN (SELECT st.id FROM sequence_steps st JOIN products p ON p.sequence_id = st.sequence_id WHERE p.id = $2)`,
      [order.contact_id, order.product_id],
    );
  }
  return "processed";
}

export async function handlePaymentEvent(ctx: AppContext, provider: string, ev: PaymentEvent): Promise<PaymentOutcome> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      "INSERT INTO payment_events (provider, provider_event_id, type, received_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id",
      [provider, ev.eventId, ev.eventType, ctx.now()],
    );
    if (!row) return "duplicate";
    const outcome = ev.kind === "paid" ? await handlePaid(tx, ctx, provider, ev, row.id) : ev.kind === "refunded" ? await handleRefunded(tx, ctx, provider, ev, row.id) : "ignored";
    await tx.query("UPDATE payment_events SET outcome = $2 WHERE id = $1", [row.id, outcome === "processed" ? "processed" : outcome]);
    return outcome;
  });
}

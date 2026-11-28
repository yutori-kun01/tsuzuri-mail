import { missingCommerceFields, type CommerceDisclosure } from "@tsuzuri/core";
import type { Hono } from "hono";
import { refreshSettings, linkUrl, url, type AppContext } from "../context.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, jst, pageHeader } from "./ui.js";

/**
 * 販売：商品・注文・特定商取引法に基づく表記。
 * 決済は Stripe（Payment Links か Checkout）で行い、通知（Webhook）を /hooks/stripe で受ける。
 * どの商品の支払いかは、Stripe 側のメタデータ tsuzuri_product に商品の識別名を入れて見分ける。
 */

const CODE = /^[a-z0-9][a-z0-9-]{0,47}$/;

interface ProductRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_amount: number | null;
  currency: string;
  status: "draft" | "active" | "archived";
  delivery_key: string | null;
  sequence_id: string | null;
  tag: string | null;
  provider_price_id: string | null;
  orders: number;
  revenue: number;
}

const STATUS_LABEL: Record<ProductRow["status"], string> = { draft: "下書き", active: "販売中", archived: "販売終了" };
const ORDER_LABEL: Record<string, string> = { paid: "支払い済み", refunded: "返金済み", partially_refunded: "一部返金", canceled: "取消" };

const yen = (n: number | null | undefined, currency = "jpy") =>
  n === null || n === undefined ? "—" : currency === "jpy" ? `${n.toLocaleString("ja-JP")} 円` : `${n.toLocaleString("ja-JP")} ${currency.toUpperCase()}`;

const COMMERCE_FIELDS: [keyof CommerceDisclosure, string, string, boolean][] = [
  ["sellerName", "販売業者（氏名または名称）", "", false],
  ["representative", "運営統括責任者（任意）", "", false],
  ["address", "所在地", "", false],
  ["phone", "電話番号", "", false],
  ["contact", "お問い合わせ（メールアドレスか URL）", "", false],
  ["price", "販売価格", "例：各商品の購入ページに表示（税込）", true],
  ["extraFees", "商品代金以外の必要料金", "例：なし（インターネット接続の通信料はお客様のご負担です）", true],
  ["paymentMethods", "お支払い方法", "例：クレジットカード", true],
  ["paymentTiming", "お支払い時期", "例：ご注文時にお支払いが確定します", true],
  ["deliveryTiming", "商品の引渡時期", "例：お支払いの確認後、すぐにメールでお届けします", true],
  ["returnPolicy", "返品・キャンセル", "例：デジタル商品の性質上、お届け後の返品はお受けしていません（商品に不具合がある場合を除く）", true],
  ["offerExpiry", "申込みの有効期限（任意）", "", false],
  ["environment", "動作環境（任意。デジタル商品のとき）", "", true],
  ["specialTerms", "特別な販売条件（任意。数量の制限、定期購入の条件など）", "", true],
];

export function registerCommerce(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/commerce", async (c) => {
    const ctx = await getCtx();
    const products = await ctx.db.query<ProductRow>(
      `SELECT p.id, p.code, p.name, p.description, p.price_amount, p.currency, p.status, p.delivery_key, p.sequence_id, t.name AS tag, p.provider_price_id,
              (SELECT count(*) FROM orders o WHERE o.product_id = p.id AND o.status IN ('paid','partially_refunded'))::int AS orders,
              COALESCE((SELECT sum(o.amount) FROM orders o WHERE o.product_id = p.id AND o.status = 'paid'), 0)::int AS revenue
         FROM products p LEFT JOIN tags t ON t.id = p.tag_id ORDER BY p.created_at`,
    );
    const seqs = await ctx.db.query<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM sequences WHERE purpose = 'product' ORDER BY created_at",
    );
    const orders = await ctx.db.query<{ id: string; product: string | null; contact_id: string | null; amount: number; currency: string; status: string; marketing_opt_in: boolean; paid_at: Date }>(
      `SELECT o.id, p.name AS product, o.contact_id, o.amount, o.currency, o.status, o.marketing_opt_in, o.paid_at
         FROM orders o LEFT JOIN products p ON p.id = o.product_id ORDER BY o.paid_at DESC LIMIT 50`,
    );
    const missing = missingCommerceFields(ctx.settings.commerce);
    const hook = url(ctx, "/hooks/stripe");
    const stripeOn = (ctx.payments ?? []).some((p) => p.name === "stripe");

    const seqOptions = (current: string | null) =>
      `<option value="">（なし）</option>${seqs.map((s) => `<option value="${h(s.id)}"${s.id === current ? " selected" : ""}>${h(s.name)}${s.status === "active" ? "" : "（配信中ではない）"}</option>`).join("")}`;
    const editor = (p?: ProductRow) => `<form method="post" action="${p ? `/admin/commerce/products/${h(p.id)}` : "/admin/commerce/products"}">
<div class="row"><div><label>商品名</label><input type="text" name="name" value="${h(p?.name)}" required maxlength="80"></div>
<div><label>識別名（Stripe のメタデータ tsuzuri_product に入れる。英小文字・数字・ハイフン）</label><input type="text" name="code" value="${h(p?.code)}" required pattern="[a-z0-9][a-z0-9-]{0,47}"${p ? " readonly" : ""}></div>
<div><label>表示用の価格（税込・円。請求額の正本は Stripe）</label><input type="number" name="price_amount" min="0" value="${h(p?.price_amount ?? "")}"></div></div>
<label>説明（任意。管理用）</label><input type="text" name="description" value="${h(p?.description)}" maxlength="200">
<div class="row"><div><label>買った人に始めるシナリオ（使い道が「商品を届ける」のもの）</label><select name="sequence_id">${seqOptions(p?.sequence_id ?? null)}</select></div>
<div><label>買った人に付けるタグ（任意）</label><input type="text" name="tag" value="${h(p?.tag)}" maxlength="40"></div></div>
<div class="row"><div><label>届けるファイル（R2 のキー。任意。シナリオの本文の %download% で配る）</label><input type="text" name="delivery_key" value="${h(p?.delivery_key)}" placeholder="products/course-a.pdf"></div>
<div><label>Stripe の価格 ID（任意。控えとして）</label><input type="text" name="provider_price_id" value="${h(p?.provider_price_id)}" placeholder="price_..."></div>
<div><label>状態</label><select name="status">${(Object.keys(STATUS_LABEL) as ProductRow["status"][]).map((s) => `<option value="${s}"${(p?.status ?? "draft") === s ? " selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select></div></div>
<div class="actions"><button type="submit">${p ? "保存する" : `${icon("plus", 16)}商品を作る`}</button></div></form>`;

    const productCards = products
      .map(
        (p) => `<details class="card"><summary><b>${h(p.name)}</b> <span class="pill${p.status === "active" ? " good" : ""}">${STATUS_LABEL[p.status]}</span>
<span class="muted"><code>${h(p.code)}</code>・${yen(p.price_amount, p.currency)}・注文 ${p.orders} 件・売上 ${yen(p.revenue, p.currency)}</span></summary>${editor(p)}</details>`,
      )
      .join("");
    const orderTable = orders.length
      ? `<div class="wrap"><table><tr><th>日時</th><th>商品</th><th>金額</th><th>状態</th><th>お知らせの同意</th><th>読者</th></tr>${orders
          .map(
            (o) =>
              `<tr><td>${h(jst(o.paid_at))}</td><td>${o.product ? h(o.product) : '<span class="muted">（商品が見分けられない）</span>'}</td><td>${yen(o.amount, o.currency)}</td><td>${h(ORDER_LABEL[o.status] ?? o.status)}</td><td>${o.marketing_opt_in ? "あり" : "なし"}</td><td>${o.contact_id ? `<a href="/admin/readers/${h(o.contact_id)}">開く</a>` : "—"}</td></tr>`,
          )
          .join("")}</table></div>`
      : emptyState({ icon: "receipt", title: "まだ注文がありません", text: "Stripe で支払いがあると、ここに出ます。" });

    const body = `${pageHeader({ title: "商品と注文", desc: "Stripe で受けた支払いを記録し、買った人に商品のシナリオやファイルを届けます。" })}
${missing.length ? `<p class="flash error">${icon("triangle-exclamation-point", 16)}特定商取引法に基づく表記が未入力です（${h(missing.join("、"))}）。販売を始める前に<a href="/admin/commerce/legal">特商法の表記</a>を入れてください。</p>` : ""}
<section class="card"><h2 class="with-icon" style="margin-top:0">${icon("info", 16)}Stripe とのつなぎ方</h2>
<ol class="muted" style="margin:0;padding-left:1.2em;line-height:1.9">
<li>ここで商品を作り、識別名を決める</li>
<li>Stripe で Payment Link（または Checkout）を作り、メタデータに <code>tsuzuri_product</code> = 識別名 を入れる。宣伝メールの同意を取るなら「プロモーションメールの同意を集める」を有効にする</li>
<li>Stripe の Webhook に <code>${h(hook)}</code> を登録し、<code>checkout.session.completed</code>・<code>checkout.session.async_payment_succeeded</code>・<code>charge.refunded</code> を送る</li>
<li>Webhook の署名シークレットを Worker の secret <code>STRIPE_WEBHOOK_SECRET</code> に入れる${stripeOn ? "（設定済み）" : "（<b>未設定</b>）"}</li></ol>
<p class="muted" style="margin:8px 0 0">購入ページなどに載せる表記：<a href="${h(linkUrl(ctx, "/legal/commerce"))}" target="_blank" rel="noopener">${h(linkUrl(ctx, "/legal/commerce"))}</a></p></section>
${productCards || emptyState({ icon: "shopping-bag", title: "まだ商品がありません", text: "下で作ると、Stripe の支払いとつながります。" })}
<details class="card add-step"${products.length ? "" : " open"}><summary>${icon("plus", 16)}商品を作る</summary>${editor()}</details>
<section class="card"><h2 style="margin-top:0">最近の注文</h2>${orderTable}</section>`;
    return c.html(adminPage({ title: "商品と注文", active: "/admin/commerce", body, flash: flashFrom(c) }));
  });

  const saveProduct = async (ctx: AppContext, f: Record<string, string | string[]>, id?: string): Promise<string | undefined> => {
    const name = one(f, "name").trim().slice(0, 80);
    const code = one(f, "code").trim().toLowerCase();
    const status = ["draft", "active", "archived"].includes(one(f, "status")) ? one(f, "status") : "draft";
    const price = one(f, "price_amount").trim();
    const priceAmount = price === "" ? null : Math.max(0, Math.floor(Number(price)));
    if (!name) return "商品名を入れてください";
    if (!id && !CODE.test(code)) return "識別名は英小文字・数字・ハイフンで 1〜48 文字にしてください";
    if (priceAmount !== null && !Number.isFinite(priceAmount)) return "価格は数字で入れてください";
    const seq = one(f, "sequence_id");
    const sequenceId = seq && (await ctx.db.query("SELECT 1 FROM sequences WHERE id::text = $1 AND purpose = 'product'", [seq])).length ? seq : null;
    const tagName = one(f, "tag").trim().slice(0, 40);
    const tagId = tagName
      ? (await ctx.db.query<{ id: string }>("INSERT INTO tags (name, category) VALUES ($1, 'cust') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [tagName]))[0]!.id
      : null;
    const key = one(f, "delivery_key").trim();
    if (key && (key.startsWith("/") || key.split("/").some((p) => p === ".." || p === ""))) return "ファイルのキーの形が正しくありません";
    const priceId = one(f, "provider_price_id").trim() || null;
    const values = [name, one(f, "description").trim().slice(0, 200) || null, priceAmount, status, key || null, sequenceId, tagId, priceId];
    if (id) {
      await ctx.db.query(
        `UPDATE products SET name = $2, description = $3, price_amount = $4, status = $5, delivery_key = $6, sequence_id = $7, tag_id = $8, provider_price_id = $9, updated_at = now()
          WHERE id::text = $1`,
        [id, ...values],
      );
      return undefined;
    }
    const rows = await ctx.db.query(
      `INSERT INTO products (code, name, description, price_amount, status, delivery_key, sequence_id, tag_id, provider_price_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (code) DO NOTHING RETURNING id`,
      [code, ...values],
    );
    return rows.length ? undefined : "同じ識別名の商品があります";
  };

  app.post("/commerce/products", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const err = await saveProduct(ctx, f).catch((e: unknown) => (String(e).includes("products_provider_price_idx") ? "同じ Stripe の価格 ID の商品があります" : Promise.reject(e)));
    if (err) return back(c, "/admin/commerce", "err", err);
    await audit(ctx.db, "product.create", one(f, "code"));
    return back(c, "/admin/commerce", "ok", "商品を作りました");
  });

  app.post("/commerce/products/:id", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const err = await saveProduct(ctx, f, c.req.param("id")).catch((e: unknown) =>
      String(e).includes("products_provider_price_idx") ? "同じ Stripe の価格 ID の商品があります" : Promise.reject(e),
    );
    if (err) return back(c, "/admin/commerce", "err", err);
    await audit(ctx.db, "product.update", c.req.param("id"));
    return back(c, "/admin/commerce", "ok", "保存しました");
  });

  // ---- 特定商取引法に基づく表記 ----
  app.get("/commerce/legal", async (c) => {
    const ctx = await getCtx();
    const d = ctx.settings.commerce ?? {};
    const missing = missingCommerceFields(d);
    const field = ([k, label, placeholder, long]: (typeof COMMERCE_FIELDS)[number]) => {
      const v = typeof d[k] === "string" ? (d[k] as string) : "";
      return long
        ? `<label>${h(label)}</label><textarea name="${k}" rows="2" maxlength="600" placeholder="${h(placeholder)}">${h(v)}</textarea>`
        : `<div><label>${h(label)}</label><input type="text" name="${k}" value="${h(v)}" maxlength="200" placeholder="${h(placeholder)}"></div>`;
    };
    const short = COMMERCE_FIELDS.filter((f) => !f[3]);
    const long = COMMERCE_FIELDS.filter((f) => f[3]);
    const page = linkUrl(ctx, "/legal/commerce");
    const body = `${pageHeader({ title: "特商法の表記", desc: "ここに入れた内容から「特定商取引法に基づく表記」のページを自動で作ります。購入ページや LP からリンクしてください。" })}
<section class="card"><p class="muted" style="margin:0">公開ページ：<a href="${h(page)}" target="_blank" rel="noopener">${h(page)}</a>${missing.length ? `（未入力：${h(missing.join("、"))}）` : ""}</p>
<p class="muted" style="margin:8px 0 0">項目は通信販売の表記で一般に求められるものです。売る商品に合っているか、最終的な文言はご自身で確かめてください（このツールは法律の助言をしません）。</p></section>
<form method="post" action="/admin/commerce/legal" class="card">
<div class="row">${short.slice(0, 2).map(field).join("")}</div>
<div class="row">${short.slice(2, 5).map(field).join("")}</div>
<label class="check"><input type="checkbox" name="disclosureOnRequest" value="1"${d.disclosureOnRequest ? " checked" : ""}>所在地・電話番号が空のときは「請求があった場合には遅滞なく開示いたします」と表示する</label>
<div class="row">${short.slice(5).map(field).join("")}</div>
${long.map(field).join("")}
<div class="actions"><button type="submit">保存する</button></div></form>`;
    return c.html(adminPage({ title: "特商法の表記", active: "/admin/commerce/legal", body, flash: flashFrom(c) }));
  });

  app.post("/commerce/legal", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const next: CommerceDisclosure = { disclosureOnRequest: one(f, "disclosureOnRequest") === "1" };
    for (const [k, , , long] of COMMERCE_FIELDS) {
      const v = one(f, k).replace(/\r\n/g, "\n").trim().slice(0, long ? 600 : 200);
      if (v) (next as Record<string, unknown>)[k] = v;
    }
    const [cur] = await ctx.db.query<{ settings: Record<string, unknown> }>("SELECT settings FROM app_settings WHERE id = 1");
    const merged = { ...(cur?.settings ?? {}), commerce: next };
    await ctx.db.query(
      "INSERT INTO app_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()",
      [JSON.stringify(merged)],
    );
    await refreshSettings(ctx);
    await audit(ctx.db, "settings.commerce");
    const missing = missingCommerceFields(next);
    return back(c, "/admin/commerce/legal", "ok", missing.length ? `保存しました（未入力：${missing.join("、")}）` : "保存しました");
  });
}

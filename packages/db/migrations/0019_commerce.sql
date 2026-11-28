-- 決済（ファネル → 購入 → 商品のメール）のための表。
-- 決済そのものは外部の決済サービス（まず Stripe）に任せ、カード情報はここに一切置かない。
-- 個人情報の正本は contacts / channels のまま。注文にはメールアドレスを持たせない（読者を消しても注文は帳簿として残す）。

-- 商品。code は決済サービス側のメタデータ（tsuzuri_product）に入れて、どの商品の支払いかを見分ける
CREATE TABLE products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name              text NOT NULL,
  description       text,
  price_amount      integer CHECK (price_amount IS NULL OR price_amount >= 0), -- 表示用（税込・最小単位。円なら円）。請求額の正本は決済サービス
  currency          text NOT NULL DEFAULT 'jpy',
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  -- 購入した人に届ける特典ファイル（R2 のキー）。メールの %download% と同じ仕組みで配る
  delivery_key      text,
  -- 購入した人に始める商品のシナリオ（purpose = 'product' のもの）
  sequence_id       uuid REFERENCES sequences(id) ON DELETE SET NULL,
  -- 購入した人に付けるタグ（自動化のきっかけに使える）
  tag_id            uuid REFERENCES tags(id) ON DELETE SET NULL,
  -- 決済サービスの価格 ID（任意。メタデータが無いときの見分けに使う）
  provider          text NOT NULL DEFAULT 'stripe',
  provider_price_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_provider_price_idx ON products (provider, provider_price_id) WHERE provider_price_id IS NOT NULL;

-- 注文（1 回の支払い = 1 行）。同じ支払いの通知が何度来ても 1 行にする
CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  provider_order_id   text NOT NULL,            -- Stripe：Checkout Session の id
  provider_payment_id text,                     -- Stripe：PaymentIntent の id（返金の通知と結びつける）
  product_id          uuid REFERENCES products(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  amount              integer NOT NULL CHECK (amount >= 0), -- 実際に支払われた額（最小単位）
  currency            text NOT NULL,
  status              text NOT NULL CHECK (status IN ('paid','refunded','partially_refunded','canceled')),
  -- 購入画面で「お知らせメールを受け取る」に同意したか（宣伝のメールはこれが true の人にだけ）
  marketing_opt_in    boolean NOT NULL DEFAULT false,
  paid_at             timestamptz NOT NULL,
  refunded_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id)
);
CREATE INDEX orders_contact_idx ON orders (contact_id);
CREATE INDEX orders_product_idx ON orders (product_id, paid_at DESC);
CREATE UNIQUE INDEX orders_payment_idx ON orders (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;

-- 決済サービスからの通知（Webhook）の受け取り記録。同じ通知を二度処理しないための一意制約が本体。
-- 通知の中身（氏名・住所・メールアドレスを含む）は保存しない
CREATE TABLE payment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  type              text NOT NULL,
  order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,
  outcome           text NOT NULL DEFAULT 'received', -- received / processed / ignored / failed
  error             text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

-- 購入した人が持つ「商品を受け取る権利」。返金で revoked_at が入る
CREATE TABLE entitlements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  granted_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX entitlements_contact_idx ON entitlements (contact_id) WHERE revoked_at IS NULL;

-- 商品のシナリオ：宣伝のメールではなく、買った商品を届ける連絡。
-- 配信停止・苦情・ハードバウンスは、ほかのメールと同じく常に優先する（送らない）
ALTER TABLE sequences DROP CONSTRAINT sequences_purpose_check;
ALTER TABLE sequences ADD CONSTRAINT sequences_purpose_check CHECK (purpose IN ('normal','reengage','product'));

-- 購入・返金を行動履歴と自動化のきっかけに足す
ALTER TABLE events DROP CONSTRAINT events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN
  ('delivered','open','click','read','goal','reply','bounce','complaint','unsubscribe','subscribe','resubscribe','preferences','purchase','refund'));

ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type IN ('link_click','tag_added','sequence_completed','form_confirmed','purchased','refunded'));

-- 購入で付いたタグ
ALTER TABLE contact_tags DROP CONSTRAINT contact_tags_reason_check;
ALTER TABLE contact_tags ADD CONSTRAINT contact_tags_reason_check CHECK (reason IN ('manual','form','rule','sequence','import','purchase'));

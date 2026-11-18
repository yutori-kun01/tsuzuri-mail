-- tsuzuri-mail 初期スキーマ（PostgreSQL 15+）
-- 正本は contacts。メール/LINE は channels として 1 人にぶら下げる（LINE は将来）。

CREATE TABLE contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        text,
  source              text,                      -- 最初の流入元（フォーム slug、import など）
  score               numeric(5,1) NOT NULL DEFAULT 50,
  tier                text NOT NULL DEFAULT 'evaluating'
                      CHECK (tier IN ('evaluating','hot','normal','low','dormant')),
  no_response_streak  integer NOT NULL DEFAULT 0,
  -- 配信の大枠。active 以外には広告メールを送らない
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','active','paused','unsubscribed','stopped')),
  attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_status_tier_idx ON contacts (status, tier);

CREATE TABLE channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('email','line')),
  address      text NOT NULL,                    -- メールアドレス（小文字に正規化）/ LINE userId
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','unsubscribed','bounced','complained','blocked')),
  soft_bounce_streak integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, address)
);
CREATE INDEX channels_contact_idx ON channels (contact_id);

-- 特定電子メール法の同意記録。削除は保存期間経過後に限る
CREATE TABLE consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  method          text NOT NULL,                 -- 'form', 'import', ...
  form_id         uuid,
  consent_text_version text NOT NULL,            -- 同意取得時に表示した文言の版
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb, -- import 元や取得画面の識別子など
  consented_at    timestamptz NOT NULL,
  confirmed_at    timestamptz,                   -- ダブルオプトインの確認日時
  revoked_at      timestamptz
);
CREATE INDEX consents_channel_idx ON consents (channel_id);

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,               -- 'src:seo-checklist' など接頭辞付き
  category   text NOT NULL CHECK (category IN ('src','int','seq','cust','ch','other')),
  color      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contact_tags (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  reason     text NOT NULL CHECK (reason IN ('manual','form','rule','sequence','import')),
  tagged_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX contact_tags_tag_idx ON contact_tags (tag_id);

CREATE TABLE segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  definition jsonb NOT NULL,                     -- 条件ツリー（AND/OR/NOT、タグ、スコア、区分など）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  allow_reentry boolean NOT NULL DEFAULT false,
  done_tag_id   uuid REFERENCES tags(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id  uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  delay_days   integer NOT NULL DEFAULT 0 CHECK (delay_days >= 0),
  send_time    time,                             -- NULL = 前ステップからの経過のみで送る
  channel      text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','line')),
  -- 分岐条件（スコア・区分・タグ）。NULL = 全員に送る
  condition    jsonb,
  subject      text,
  body_markdown text NOT NULL,
  UNIQUE (sequence_id, position)
);

CREATE TABLE forms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  tag_id          uuid REFERENCES tags(id),
  sequence_id     uuid REFERENCES sequences(id),
  lead_magnet_key text,                          -- S3 上の特典ファイルのキー
  consent_text_version text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE consents ADD CONSTRAINT consents_form_fk FOREIGN KEY (form_id) REFERENCES forms(id);

CREATE TABLE enrollments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sequence_id   uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  next_position integer NOT NULL DEFAULT 1,
  next_send_at  timestamptz,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','completed','stopped')),
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- 同じシナリオに同時に2回入らない
CREATE UNIQUE INDEX enrollments_one_active_idx ON enrollments (contact_id, sequence_id) WHERE status = 'active';
-- スケジューラが「期限の来たもの」を拾う
CREATE INDEX enrollments_due_idx ON enrollments (next_send_at) WHERE status = 'active';

CREATE TABLE broadcasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id    uuid REFERENCES segments(id),
  channel       text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','line')),
  subject       text,
  body_markdown text NOT NULL,
  important     boolean NOT NULL DEFAULT false, -- true なら低下区分にも届く
  scheduled_at  timestamptz,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','scheduled','sending','sent','canceled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 個々の送信記録。idempotency_key の一意制約が二重送信防止の要
CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     text NOT NULL UNIQUE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  enrollment_id       uuid REFERENCES enrollments(id) ON DELETE SET NULL,
  step_id             uuid REFERENCES sequence_steps(id) ON DELETE SET NULL,
  broadcast_id        uuid REFERENCES broadcasts(id) ON DELETE SET NULL,
  provider            text NOT NULL,
  provider_message_id text,
  link_count          integer NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sent','delivered','bounced','complained','failed')),
  attempts            integer NOT NULL DEFAULT 0,
  responded           boolean NOT NULL DEFAULT false, -- 人間の反応があったか（未反応カウント用）
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX messages_contact_idx ON messages (contact_id, sent_at DESC);
CREATE INDEX messages_provider_idx ON messages (provider_message_id);

-- 行動履歴（スコア計算の元データ）。ボット判定の結果も残し、後から基準を見直せるようにする
CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
  type        text NOT NULL CHECK (type IN
              ('delivered','open','click','read','goal','reply','bounce','complaint','unsubscribe','subscribe')),
  machine     boolean NOT NULL DEFAULT false,   -- 機械開封
  bot_reason  text,                              -- ボットと判定した理由（NULL = 人間）
  weight      numeric(6,2),                      -- goal の点数上書き
  data        jsonb NOT NULL DEFAULT '{}'::jsonb, -- url など。IP や UA の生値は保存しない
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_contact_time_idx ON events (contact_id, occurred_at DESC);

CREATE TABLE score_settings (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- 単一行
  settings   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE score_settings_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settings   jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE score_history (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  day        date NOT NULL,
  score      numeric(5,1) NOT NULL,
  tier       text NOT NULL,
  breakdown  jsonb NOT NULL,
  PRIMARY KEY (contact_id, day)
);

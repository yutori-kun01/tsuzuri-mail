-- 配信設定：配信の種類（トピック）ごとの受け取り可否と、一時停止

-- 配信の種類。default_subscribed = true は「受け取らない」を選ばない限り届く、false は「受け取る」を選んだ人にだけ届く
CREATE TABLE topics (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  description        text,
  default_subscribed boolean NOT NULL DEFAULT true,
  visible            boolean NOT NULL DEFAULT true,  -- 配信設定ページに出すか
  position           integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- 読者が選んだ値（既定と同じなら行が無くてもよい）
CREATE TABLE contact_topic_prefs (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  subscribed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, topic_id)
);

-- 一時停止（この日時までは一斉配信もシナリオも送らない。確認メールなどは送る）
ALTER TABLE contacts ADD COLUMN paused_until timestamptz;

-- 一斉配信・シナリオがどの種類か（NULL = 種類なし＝配信中の全員が対象）
ALTER TABLE broadcasts ADD COLUMN topic_id uuid REFERENCES topics(id) ON DELETE SET NULL;
ALTER TABLE sequences ADD COLUMN topic_id uuid REFERENCES topics(id) ON DELETE SET NULL;

-- 読者の操作の記録（配信設定の変更も events に残す）
ALTER TABLE events DROP CONSTRAINT events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN
  ('delivered','open','click','read','goal','reply','bounce','complaint','unsubscribe','subscribe','resubscribe','preferences'));

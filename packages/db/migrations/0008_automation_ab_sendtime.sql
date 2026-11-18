-- 自動化のルール：「○○したら△△する」
--   trigger_type  link_click（このURLを含むリンクを押した）/ tag_added（このタグが付いた）
--                 sequence_completed（このシナリオを最後まで受け取った）/ form_confirmed（このフォームで登録が完了した）
--   action_type   add_tag / remove_tag（タグ名）/ start_sequence / stop_sequence（シナリオの id）
CREATE TABLE automation_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  trigger_type  text NOT NULL CHECK (trigger_type IN ('link_click','tag_added','sequence_completed','form_confirmed')),
  trigger_value text NOT NULL,
  action_type   text NOT NULL CHECK (action_type IN ('add_tag','remove_tag','start_sequence','stop_sequence')),
  action_value  text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 同じルールは同じ読者に 1 回だけ動く（ルール同士がぐるぐる呼び合わないように）
CREATE TABLE automation_runs (
  rule_id    uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, contact_id)
);

-- 定期処理の進み具合（最後に処理した時刻など）
CREATE TABLE automation_state (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- 送信の時刻：send_after より前には送らない（読者ごとの最適な時刻）。variant は件名の A/B テスト用
ALTER TABLE messages
  ADD COLUMN send_after timestamptz,
  ADD COLUMN variant text CHECK (variant IN ('a','b'));

-- 件名の A/B テストと、送信時刻の最適化
ALTER TABLE broadcasts
  ADD COLUMN subject_b text,
  ADD COLUMN ab_percent integer CHECK (ab_percent IS NULL OR ab_percent BETWEEN 10 AND 50),
  ADD COLUMN ab_wait_minutes integer CHECK (ab_wait_minutes IS NULL OR ab_wait_minutes BETWEEN 30 AND 2880),
  ADD COLUMN ab_decide_at timestamptz,
  ADD COLUMN ab_winner text CHECK (ab_winner IN ('a','b')),
  ADD COLUMN optimize_send_time boolean NOT NULL DEFAULT false;

ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft','scheduled','testing','sending','sent','canceled'));

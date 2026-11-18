-- ステップの送るタイミング：分単位の「○分後・○時間後」（NULL なら delay_days と send_time を使う。0 = すぐ）
ALTER TABLE sequence_steps
  ADD COLUMN delay_minutes integer CHECK (delay_minutes IS NULL OR delay_minutes >= 0);

-- フッターのひな形。本文の最後に付ける。法定の表示（送信者名・配信停止・送信者情報）は保存時に確かめる
CREATE TABLE footers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  body        text NOT NULL,                       -- Markdown。置き換え文字が使える
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- 既定のフッターは 1 つだけ
CREATE UNIQUE INDEX footers_one_default ON footers (is_default) WHERE is_default;

ALTER TABLE broadcasts ADD COLUMN footer_id uuid REFERENCES footers(id) ON DELETE SET NULL;
ALTER TABLE sequences ADD COLUMN footer_id uuid REFERENCES footers(id) ON DELETE SET NULL;

-- 最初のひな形 2 つ。「標準」はこれまでのフッターと同じ内容
INSERT INTO footers (name, body, is_default) VALUES
  ('標準', E'送信者：%sender%\nお問い合わせ：%contact%\n[送信者情報（住所など）はこちら](%sender_info%)\n[配信停止](%cancel%) ｜ [配信設定](%settings%)', true),
  ('シンプル（リンク 2 つ）', E'このメールは %sender% からお送りしています。\n[配信停止](%cancel%) ｜ [送信者情報](%sender_info%)', false);

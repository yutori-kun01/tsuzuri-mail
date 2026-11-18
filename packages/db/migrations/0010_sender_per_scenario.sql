-- シナリオ・一斉配信ごとの送信者（空なら管理画面の「設定」の送信者を使う）
--   from_address のドメインは、送信ドメイン（SES で認証済み）のどれかに限る（アプリ側で検証。AWS 側の権限もそのドメインに絞っている）
ALTER TABLE sequences
  ADD COLUMN from_name text,
  ADD COLUMN from_address text,
  ADD COLUMN reply_to text;
ALTER TABLE broadcasts
  ADD COLUMN from_name text,
  ADD COLUMN from_address text,
  ADD COLUMN reply_to text;

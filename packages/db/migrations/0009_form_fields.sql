-- 登録フォームの入力項目（メールアドレス以外）と受付期間
--   fields        入力項目の配列（packages/core の FormField）。key = "name" は表示名、それ以外は contacts.attributes に入る。
--                 既存のフォームは今までどおり「お名前（任意）」だけを持つ。
--   accept_from   この日時より前は受け付けない（NULL なら制限なし）
--   accept_until  この日時より後は受け付けない（NULL なら制限なし）
ALTER TABLE forms
  ADD COLUMN fields jsonb NOT NULL
    DEFAULT '[{"key":"name","label":"お名前","type":"text","required":false,"enabled":true,"options":[],"defaultValue":""}]'::jsonb,
  ADD COLUMN accept_from timestamptz,
  ADD COLUMN accept_until timestamptz;

-- フォームごとに、登録の確認方法を選べるようにする
--   double_optin  true：確認メールのリンクを押して登録完了（ダブルオプトイン）
--                 false：フォームの送信だけで登録完了（シングルオプトイン。同意の記録は同じように残す）
-- 既存のフォームはすべて今までどおりダブルオプトインのまま。
ALTER TABLE forms ADD COLUMN double_optin boolean NOT NULL DEFAULT true;

-- HTML メール、キャンペーンごとのフォーム・完了ページ、フォームのセキュリティ設定

ALTER TABLE sequence_steps ADD COLUMN body_format text NOT NULL DEFAULT 'markdown' CHECK (body_format IN ('markdown','html'));
ALTER TABLE broadcasts ADD COLUMN body_format text NOT NULL DEFAULT 'markdown' CHECK (body_format IN ('markdown','html'));

ALTER TABLE forms
  ADD COLUMN confirm_body_format text NOT NULL DEFAULT 'markdown' CHECK (confirm_body_format IN ('markdown','html')),
  -- 自前のフォームページの見出し・説明・ボタン
  ADD COLUMN page_title text,
  ADD COLUMN page_description text,
  ADD COLUMN button_label text NOT NULL DEFAULT '登録する',
  -- 送信直後（確認メールを送った）の案内：URL があればそこへ移動、なければメッセージを表示
  ADD COLUMN sent_url text,
  ADD COLUMN sent_message text,
  -- 登録確定後の案内：thanks_url があればそこへ移動、なければメッセージを表示
  ADD COLUMN confirmed_message text,
  ADD COLUMN privacy_url text,
  -- 埋め込みフォームを置いてよいサイト（例 https://example.com）。空なら制限しない
  ADD COLUMN allowed_origins text[] NOT NULL DEFAULT '{}';

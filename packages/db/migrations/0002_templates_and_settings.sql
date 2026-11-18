-- 置き換え文字、アプリ設定、確認メール、送信処理のための追加

-- 独自の置き換え文字（%lp_url% など）
CREATE TABLE custom_variables (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  kind       text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','url')),
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- アプリ全体の設定（送信者表示、フッター、送信元など）。単一行
CREATE TABLE app_settings (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- フォームごとの確認メールと完了ページ
ALTER TABLE forms
  ADD COLUMN confirm_subject text NOT NULL DEFAULT '【確認】登録を完了してください',
  ADD COLUMN confirm_body_markdown text NOT NULL DEFAULT E'%name|%ご登録ありがとうございます。\n\n下のボタンを押すと登録が完了します。\n\n[登録を完了する](%confirm%)\n\n心当たりがない場合は、このメールを破棄してください。',
  ADD COLUMN thanks_url text,
  ADD COLUMN active boolean NOT NULL DEFAULT true;

-- 送信処理：取得済み（sending）状態とリンク一覧
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('queued','sending','sent','delivered','bounced','complained','failed','skipped'));
ALTER TABLE messages
  ADD COLUMN kind text NOT NULL DEFAULT 'sequence' CHECK (kind IN ('sequence','broadcast','optin')),
  ADD COLUMN form_id uuid REFERENCES forms(id) ON DELETE SET NULL,
  ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN error text;
CREATE INDEX messages_queued_idx ON messages (queued_at) WHERE status = 'queued';

-- 特典ダウンロード（目標行動）を記録できるように
ALTER TABLE events DROP CONSTRAINT events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN
  ('delivered','open','click','read','goal','reply','bounce','complaint','unsubscribe','subscribe','resubscribe'));

-- 休眠者の再確認シナリオかどうか
ALTER TABLE sequences ADD COLUMN purpose text NOT NULL DEFAULT 'normal' CHECK (purpose IN ('normal','reengage'));


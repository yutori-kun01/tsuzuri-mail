-- 管理画面：操作ログ、ログイン失敗の記録、一斉配信ごとの宛先条件

CREATE TABLE admin_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action      text NOT NULL,                 -- 'broadcast.schedule' など
  target      text,                          -- 対象の id
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_time_idx ON admin_audit (occurred_at DESC);

-- ログイン失敗（総当たり対策のロックに使う。IP などは保存しない）
CREATE TABLE admin_login_failures (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- 一斉配信ごとの宛先条件（segments を作らずに直接持てるように）
ALTER TABLE broadcasts
  ADD COLUMN segment_definition jsonb,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

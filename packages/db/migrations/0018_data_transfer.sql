-- データの引き継ぎ：書き出した暗号化ファイルを、ダウンロードできるよう一時的に置く（1 時間で消す）。
-- 中身は暗号化済みで、暗号化キーはサーバーに保存しない（画面に 1 回だけ表示する）。
CREATE TABLE data_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file       bytea NOT NULL,
  summary    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

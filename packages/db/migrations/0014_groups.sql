-- 一覧のグループ分け：シナリオとフォームを、名前をつけたグループにまとめて表示する（配信の動きには影響しない）
CREATE TABLE item_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('sequence','form')),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

-- グループを消しても中身は消さず「グループなし」に戻す
ALTER TABLE sequences ADD COLUMN group_id uuid REFERENCES item_groups(id) ON DELETE SET NULL;
ALTER TABLE forms ADD COLUMN group_id uuid REFERENCES item_groups(id) ON DELETE SET NULL;

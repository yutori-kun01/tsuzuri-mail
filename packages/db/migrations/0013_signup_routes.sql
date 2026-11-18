-- 登録経路：フォームの URL に ?r=識別名 を付けて、どこから登録したかを数える（docs/requirements-2026-11-analytics.md）
CREATE TABLE signup_routes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 登録（同意）ごとの経路。経路を消しても登録の記録は残す
ALTER TABLE consents ADD COLUMN route_id uuid REFERENCES signup_routes(id) ON DELETE SET NULL;
CREATE INDEX consents_route_idx ON consents (route_id) WHERE route_id IS NOT NULL;

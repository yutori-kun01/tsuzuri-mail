-- 管理画面のパスキー（WebAuthn）。パスワード＋認証アプリの代わりにログインできる。
-- 公開鍵だけを保存する（秘密鍵は端末やパスワード管理の中にあり、サーバーには来ない）。
CREATE TABLE admin_passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id text NOT NULL UNIQUE,              -- base64url
  public_key    text NOT NULL,                     -- SPKI DER の base64url
  alg           integer NOT NULL,                  -- COSE のアルゴリズム（-7 ES256 / -8 EdDSA / -257 RS256）
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- 発行したチャレンジ（1 回だけ使える。期限を過ぎたものは使えない）
CREATE TABLE admin_webauthn_challenges (
  challenge  text PRIMARY KEY,
  purpose    text NOT NULL CHECK (purpose IN ('register','login')),
  expires_at timestamptz NOT NULL
);

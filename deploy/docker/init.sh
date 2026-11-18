#!/usr/bin/env bash
# Docker 版の初回準備。VPS のログインユーザー（root ではない）で 1 回だけ実行する。何度実行しても壊れない。
#   bash deploy/docker/init.sh
# 設定・データの置き場所：~/tsuzuri（TSUZURI_HOME で変更可）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${TSUZURI_HOME:-$HOME/tsuzuri}"

if [ "$(id -u)" -eq 0 ]; then echo "root ではなく、普段のユーザーで実行してください"; exit 1; fi
command -v docker >/dev/null || { echo "Docker がありません"; exit 1; }
docker compose version >/dev/null || { echo "docker compose（v2）がありません"; exit 1; }

umask 077
mkdir -p "$HOME_DIR/data/files/magnets" "$HOME_DIR/data/backups"
chmod 700 "$HOME_DIR"

if [ ! -f "$HOME_DIR/tsuzuri.env" ]; then
  cp "$HERE/../vps/tsuzuri.env.example" "$HOME_DIR/tsuzuri.env"
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  sed -i "s|^TOKEN_SECRET=.*|TOKEN_SECRET=${SECRET}|" "$HOME_DIR/tsuzuri.env"
  # Docker 版のコンテナ内の場所に合わせる
  sed -i "s|^DATABASE_CA_FILE=.*|DATABASE_CA_FILE=/config/supabase-ca.crt|" "$HOME_DIR/tsuzuri.env"
  chmod 600 "$HOME_DIR/tsuzuri.env"
  echo "  $HOME_DIR/tsuzuri.env を作りました（署名用の鍵は生成済み）。残りの値を埋めてください（docs/vps.md）"
else
  echo "  $HOME_DIR/tsuzuri.env はあります（上書きしません）"
fi

# コンテナはこのユーザーの UID/GID で動かす（~/tsuzuri の読み書きのため）
ENVF="$HERE/.env"
# 手で足した TSUZURI_COMPOSE_EXTRA（deploy.sh が読む）は残す
KEEP="$( [ -f "$ENVF" ] && grep -E '^TSUZURI_COMPOSE_EXTRA=' "$ENVF" || true )"
printf 'TSUZURI_HOME=%s\nTSUZURI_UID=%s\nTSUZURI_GID=%s\n' "$HOME_DIR" "$(id -u)" "$(id -g)" > "$ENVF"
if [ -n "$KEEP" ]; then printf '%s\n' "$KEEP" >> "$ENVF"; fi
echo "  $ENVF に TSUZURI_HOME・UID・GID を書きました（秘密値は含まない）"
echo "完了。次は docs/vps.md の「設定ファイル」から進めてください。"

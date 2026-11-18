#!/usr/bin/env bash
# Docker 版：コードを最新にして、作り直して、起動し直す。VPS のログインユーザーで実行する。
#   bash deploy/docker/deploy.sh [ブランチ名]
# VPS 専用の compose ファイル（例 compose.npm.yml）も重ねるときは TSUZURI_COMPOSE_EXTRA に
# 空白区切りで書く（deploy/docker からの相対パスか絶対パス）。環境変数になければ deploy/docker/.env の同名の行を読む。
set -euo pipefail
BRANCH="${1:-main}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"

EXTRA="${TSUZURI_COMPOSE_EXTRA-}"
if [ -z "$EXTRA" ] && [ -f "$HERE/.env" ]; then
  EXTRA="$(sed -n 's/^TSUZURI_COMPOSE_EXTRA=//p' "$HERE/.env" | tail -n 1 | tr -d "\r\"'")"
fi
COMPOSE=(docker compose -f "$HERE/compose.yml")
read -r -a EXTRA_FILES <<< "$EXTRA" || true
for f in "${EXTRA_FILES[@]}"; do
  case "$f" in /*) p="$f" ;; *) p="$HERE/$f" ;; esac
  if [ ! -f "$p" ]; then echo "追加の compose ファイルがありません：$p"; exit 1; fi
  COMPOSE+=(-f "$p")
done
if [ "${#EXTRA_FILES[@]}" -gt 0 ]; then echo "== 追加の compose ファイル：${EXTRA_FILES[*]}"; fi
cd "$APP"

echo "== コードの取得（$BRANCH）"
git fetch --depth 50 origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"

echo "== イメージの作成"
"${COMPOSE[@]}" build

echo "== 起動（DB の構造は起動時に自動で最新になる）"
"${COMPOSE[@]}" up -d tsuzuri

echo "== 応答の確認"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
    echo "起動しました"
    "${COMPOSE[@]}" ps
    exit 0
  fi
  sleep 2
done
echo "60 秒たっても /health が応答しません。ログを確認してください："
"${COMPOSE[@]}" logs --tail 50 tsuzuri
exit 1

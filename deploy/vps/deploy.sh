#!/usr/bin/env bash
# コードを最新にして再起動する。root で実行する。
#   sudo bash /opt/tsuzuri/app/deploy/vps/deploy.sh [ブランチ名]
set -euo pipefail
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
BRANCH="${1:-main}"
APP=/opt/tsuzuri/app

if [ "$(id -u)" -ne 0 ]; then echo "root で実行してください"; exit 1; fi
cd "$APP"

echo "== コードの取得（$BRANCH）"
git fetch --depth 50 origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"

echo "== 依存パッケージ"
pnpm install --frozen-lockfile

echo "== テスト（失敗したら再起動しない）"
pnpm typecheck
pnpm test

echo "== 再起動（起動時に DB の構造も自動で最新にする）"
systemctl restart tsuzuri
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
    echo "起動しました"
    journalctl -u tsuzuri -n 5 --no-pager
    exit 0
  fi
  sleep 1
done
echo "起動を確認できませんでした。journalctl -u tsuzuri -n 50 で原因を確認してください"
exit 1

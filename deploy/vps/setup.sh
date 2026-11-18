#!/usr/bin/env bash
# Xserver VPS（Ubuntu 24.04）の初期設定。root で 1 回だけ実行する。
#   sudo bash deploy/vps/setup.sh
# 何度実行しても壊れないように書いてある。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "root で実行してください（sudo bash $0）"; exit 1; fi

echo "== パッケージの更新と必要なものの導入"
apt-get update
apt-get -y upgrade
apt-get install -y curl git ufw unattended-upgrades ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "== セキュリティ更新の自動適用"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== Node.js 22"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable

echo "== Caddy（HTTPS の自動化）"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "== 実行用のユーザーとディレクトリ"
id tsuzuri >/dev/null 2>&1 || useradd --system --home /var/lib/tsuzuri --shell /usr/sbin/nologin tsuzuri
install -d -o root -g root -m 755 /opt/tsuzuri
install -d -o root -g tsuzuri -m 750 /etc/tsuzuri
install -d -o tsuzuri -g tsuzuri -m 750 /var/lib/tsuzuri /var/lib/tsuzuri/files /var/lib/tsuzuri/backups

echo "== 設定ファイル（無ければ雛形から作り、署名用の鍵を生成）"
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f /etc/tsuzuri/tsuzuri.env ]; then
  install -o root -g tsuzuri -m 640 "$HERE/tsuzuri.env.example" /etc/tsuzuri/tsuzuri.env
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  sed -i "s|^TOKEN_SECRET=.*|TOKEN_SECRET=${SECRET}|" /etc/tsuzuri/tsuzuri.env
  echo "  /etc/tsuzuri/tsuzuri.env を作りました。残りの値を埋めてください（docs/vps.md）"
fi

echo "== systemd と Caddy の設定"
install -m 644 "$HERE/tsuzuri.service" /etc/systemd/system/tsuzuri.service
install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
install -d -o caddy -g caddy -m 755 /var/log/caddy
systemctl daemon-reload
systemctl enable tsuzuri
systemctl reload caddy || systemctl restart caddy

echo "== ファイアウォール（SSH・HTTP・HTTPS だけ開ける）"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "完了。次は docs/vps.md の「コードの配置」から進めてください。"

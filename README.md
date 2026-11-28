# tsuzuri-mail

個人ライター向けの小型MA。メルマガ、リードマグネットごとのステップ配信、独自の読者スコアによる配信の出し分け、商品の販売と購入者へのメールを、Cloudflare Workers・Supabase（PostgreSQL）・Amazon SES で動かす。

- 要件：[docs/requirements.md](docs/requirements.md)
- SES の導入と本番申請：[docs/ses-setup.md](docs/ses-setup.md)
- 本番の運用（Cloudflare Workers ＋ Supabase）：[docs/cloudflare.md](docs/cloudflare.md)
- 販売（商品・注文・特商法の表記・Stripe）：[docs/commerce.md](docs/commerce.md)
- 旧構成（移行元）：Xserver VPS [docs/vps.md](docs/vps.md)、AWS Lambda [docs/aws-runbook.md](docs/aws-runbook.md)
- メール本文と置き換え文字の書き方：[docs/content.md](docs/content.md)
- 管理画面：[docs/admin.md](docs/admin.md)
- セキュリティ対策：[docs/security.md](docs/security.md)
- 開発ルール：[CLAUDE.md](CLAUDE.md)

## 構成

| パス | 中身 |
| --- | --- |
| `packages/core` | ドメインロジック（読者スコア、置き換え文字、メールの組み立て、ボット・機械開封の判定、送信インターフェース、署名付きトークン） |
| `packages/server` | DB 処理、公開ページ（フォーム・配信停止・計測・特商法の表記）、管理画面（`/admin`）、決済の Webhook、Workers の入口（`src/workers/`）、管理コマンド |
| `content/` | シナリオ・フォーム・置き換え文字（Markdown） |
| `packages/db/migrations` | PostgreSQL のスキーマ |
| `deploy/cloudflare/` | Cloudflare Workers の設定（wrangler.jsonc） |
| `infra/` | AWS の構成定義（CDK）。SES まわり（設定セット、SNS → SQS、IAM ユーザー）。`-c tsuzuri:hosting=lambda` で Lambda 版（旧構成） |
| `deploy/vps/` | 旧構成：VPS の初期設定・起動・更新（systemd、Caddy、setup.sh、deploy.sh） |

## 開発

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

ローカルで試す（DB を用意しなくても動く。メールは送らず画面に表示）：

```bash
pnpm tsuzuri sync
```

```bash
pnpm tsuzuri dev
```

Cloudflare Workers の形にまとめられるか確かめる（デプロイはしない）：

```bash
pnpm cf:check
```

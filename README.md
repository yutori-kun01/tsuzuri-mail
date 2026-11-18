# tsuzuri-mail

個人ライター向けの小型MA。メルマガ、リードマグネットごとのステップ配信、独自の読者スコアによる配信の出し分けを、自前の PostgreSQL と Amazon SES で動かす。

- 要件：[docs/requirements.md](docs/requirements.md)
- SES の導入と本番申請：[docs/ses-setup.md](docs/ses-setup.md)
- 本番の運用（Xserver VPS）：[docs/vps.md](docs/vps.md)
- AWS Lambda で動かす場合の手順（予備）：[docs/aws-runbook.md](docs/aws-runbook.md)
- メール本文と置き換え文字の書き方：[docs/content.md](docs/content.md)
- 管理画面：[docs/admin.md](docs/admin.md)
- セキュリティ対策：[docs/security.md](docs/security.md)
- 開発ルール：[CLAUDE.md](CLAUDE.md)

## 構成

| パス | 中身 |
| --- | --- |
| `packages/core` | ドメインロジック（読者スコア、置き換え文字、メールの組み立て、ボット・機械開封の判定、送信インターフェース、署名付きトークン） |
| `packages/server` | DB 処理、公開ページ（フォーム・配信停止・計測）、管理画面（`/admin`）、Lambda の入口、管理コマンド |
| `content/` | シナリオ・フォーム・置き換え文字（Markdown） |
| `packages/db/migrations` | PostgreSQL のスキーマ |
| `infra/` | AWS の構成定義（CDK）。既定は VPS 用（SES まわりだけ）、`-c tsuzuri:hosting=lambda` で Lambda 版 |
| `deploy/vps/` | VPS の初期設定・起動・更新（systemd、Caddy、setup.sh、deploy.sh） |

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

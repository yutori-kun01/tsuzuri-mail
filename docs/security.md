# セキュリティ対策の一覧

| 対象 | 対策 | 場所 |
| --- | --- | --- |
| AWS の権限 | アクセスキーを作らず、Lambda のロールに必要な権限だけ付ける。SES の送信は `mail.example.com` の ID と設定セットに限定 | infra/lib/stack.ts |
| 秘密値 | DB 接続文字列とトークン鍵は SSM パラメータストア（暗号化）に置き、コード・ログ・リポジトリに書かない | runtime.ts、docs/aws-runbook.md |
| 個人情報 | ログには contact id までしか出さない。リンクのトークンにもメールアドレスを含めない。開封・クリックの IP やユーザーエージェントの生値は保存しない | CLAUDE.md、tracking.ts |
| 配信停止・確認リンク | HMAC-SHA256 の署名付きトークン。用途ごとに分け、比較は定数時間 | packages/core/src/security/tokens.ts |
| 計測リンクの転送 | 送信時に記録した URL にしか転送しない（任意の URL へ飛ばす「オープンリダイレクト」にならない） | tracking.ts |
| フォームのスパム | 見えない入力欄（ハニーポット）、メールアドレスの形式・長さチェック、名前の制御文字除去 | http/app.ts |
| 埋め込みフォームの悪用 | フォームごとに `allowed_origins` を設定すると、それ以外のサイトからの送信を拒否 | http/app.ts、content/forms |
| 確認メールの大量送信（他人のアドレスを入れる嫌がらせ） | 同じアドレスへの確認メールは 24 時間で 3 通まで。登録済みかどうかは画面で区別しない | subscription.ts |
| 大量アクセス | VPS：アプリ内で IP ごとに制限（フォーム送信・ログインは 1 分 10 回、全体は 1 分 600 回）、Caddy で 1MB を超える本文を拒否。Lambda：API Gateway で 1 秒 20 リクエスト。読者向けの 16KB を超えるリクエストは拒否 | http/ratelimit.ts、deploy/vps/Caddyfile |
| VPS | アプリは 127.0.0.1 だけで待ち受け、Caddy 経由で HTTPS。ファイアウォールは 22・80・443 のみ。systemd で権限を絞る（書き込みは /var/lib/tsuzuri だけ）。自動のセキュリティ更新 | deploy/vps |
| VPS の AWS アクセスキー | IAM ユーザー tsuzuri-vps は SES の送信とイベントの受け取りだけ。送信元は @mail.example.com、接続元は VPS の IP に限定。キーは VPS の設定ファイル（Docker 版は ~/tsuzuri/tsuzuri.env の 600、systemd 版は /etc/tsuzuri/tsuzuri.env の 640）にだけ置く。サンドボックス中だけ、宛先の検証済み ID への送信も許可する | infra/lib/vps-stack.ts |
| ページの改ざん・埋め込み | CSP（外部スクリプト禁止、他サイトへの埋め込み禁止）、HSTS、X-Frame-Options、nosniff | http/app.ts |
| 二重送信 | DB の一意制約と「送信中」への状態遷移で、同じメールを 2 回送らない | sending.ts、migrations |
| データの消失 | 毎晩、主要な表を暗号化した S3 に書き出し（90 日保存）。特典ファイルの置き場はバージョン管理付き・非公開 | backup.ts、infra/lib/stack.ts |
| 不要なデータ | 行動履歴とスコア履歴は 400 日で自動削除 | backup.ts |
| 監視 | 送信失敗の滞留、バウンス率・苦情率、関数のエラーをメールで通知 | infra/lib/stack.ts |
| 管理画面 | パスワード（scrypt）＋認証アプリ（TOTP）の二段階認証、5 回失敗で 15 分ロック、12 時間で失効する HttpOnly・Secure・SameSite=Strict の Cookie、同一サイト以外からの書き込み拒否、全操作の記録、他サイトへの埋め込み禁止 | packages/server/src/admin、docs/admin.md |

## 残っている課題

- 依存パッケージの脆弱性は、定期的に次のコマンドで確認する：

```bash
pnpm audit
```

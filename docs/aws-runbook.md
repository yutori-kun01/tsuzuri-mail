# AWS Lambda への導入手順（予備）

> 本番は Xserver VPS で動かす方針になった（docs/vps.md）。この文書は Lambda で動かす場合の予備の手順。
> Lambda 版のデプロイは `npx cdk deploy -c tsuzuri:hosting=lambda Tsuzuri`。

コマンドはすべて手元の Mac / PC のターミナルで、リポジトリ直下から実行する。
`<...>` は自分の値に置き換える。個人情報（メールアドレスなど）はコマンドの引数や環境変数で渡し、リポジトリのファイルには書かない。

所要時間の目安：アカウント作成からテスト送信まで 1〜2 時間（DNS の反映待ちを除く）。

## 0. 手元に入れておくもの

- Node.js 22 以上、pnpm（`corepack enable`）
- AWS CLI v2
- Supabase のアカウント（無料プラン）

```bash
pnpm install
```

## 1. AWS アカウント（ブラウザ）

- [x] AWS アカウントの作成
- [x] Budgets（月 5 USD、85%・100%・予測 100% で通知）
- [x] SES の ID `mail.example.com`、DKIM、MAIL FROM、DMARC（docs/ses-setup.md の 1.）
- [ ] ルートユーザーに MFA を設定する（未設定なら最優先）
- [ ] IAM Identity Center を有効化し、自分用のユーザーに `AdministratorAccess` を割り当てる（以降はこのユーザーで作業）

## 2. CLI でログイン

```bash
aws configure sso
```

```bash
aws sso login --profile <プロファイル名>
```

以降のコマンドは `AWS_PROFILE=<プロファイル名>` を付けるか、`export AWS_PROFILE=<プロファイル名>` してから実行する。

## 3. データベース（Supabase の無料プラン）

1. Supabase で新しいプロジェクトを作る。リージョンは東京（Northeast Asia (Tokyo)）を選び、データベースのパスワードを控える（パスワード管理ツールに保存）。
2. プロジェクトの「Connect」から **Transaction pooler** の接続文字列（ポート 6543）をコピーし、末尾に `?sslmode=require` を付ける。Lambda のように接続が短く何度も作られる環境では、この接続方式が向いている。
3. Project Settings → Database → SSL Configuration から CA 証明書をダウンロードし、リポジトリの外に置く。`.env` に `DATABASE_CA_FILE`（場所）と `DATABASE_CA_SHA256`（`.env.example` 参照）を書く。Lambda 用には SSM の `/tsuzuri/database-ca` に置く。
4. Supabase の「Data API」は使わないので、Supabase の画面でテーブルを公開しない（このアプリは REST や公開キーを使わず、直接 PostgreSQL に接続する）。
5. 手元の `.env` に `DATABASE_URL=<接続文字列>` を書く（`.env` はコミットされない）。
6. 構造を作る：

```bash
pnpm tsuzuri migrate
```

## 4. 秘密値を AWS に保存（SSM パラメータストア）

```bash
aws ssm put-parameter --region ap-northeast-1 --type SecureString --name /tsuzuri/database-url --value "<接続文字列>"
```

```bash
aws ssm put-parameter --region ap-northeast-1 --type SecureString --name /tsuzuri/token-secret --value "$(openssl rand -base64 48)"
```

## 5. 送信者表示とコンテンツ

1. `content/settings.example.json` を `content/settings.json` にコピーして埋める（`content/settings.json` はコミットされない）。
2. 反映する：

```bash
pnpm tsuzuri settings content/settings.json
```

```bash
pnpm tsuzuri sync
```

## 6. デプロイ

初回だけ CDK の準備をする：

```bash
cd infra && npx cdk bootstrap aws://<アカウントID>/ap-northeast-1
```

デプロイする（返信先・通知先などはここで渡す）：

```bash
cd infra && TSUZURI_FROM_NAME="<送信者名>" TSUZURI_REPLY_TO="<返信先アドレス>" TSUZURI_PRIVACY_URL="<プライバシーポリシーのURL>" TSUZURI_ALERT_EMAIL="<通知を受けるアドレス>" npx cdk deploy
```

デプロイは、`mail.example.com` の証明書の発行待ちで止まる。止まっている間に、次のコマンドで検証用の CNAME を確認して DNS に登録する（登録後、数分〜数十分で先に進む）：

```bash
aws acm list-certificates --region ap-northeast-1
```

```bash
aws acm describe-certificate --region ap-northeast-1 --certificate-arn <上で出た ARN> --query "Certificate.DomainValidationOptions[].ResourceRecord"
```

通知先アドレスには、SNS の購読確認メールが届くので、リンクを押して承認する。

## 7. DNS（Xserver の DNS レコード設定）

SES 関係（DKIM・MAIL FROM・DMARC）は登録済み。デプロイ後に追加するのは 1 件だけ。

| Outputs の名前 | 登録するレコード |
| --- | --- |
| PublicHostCname | `mail.example.com` の CNAME（フォーム・配信停止・計測リンク用） |

あわせて、アカウント単位の抑制リストを有効にする（docs/ses-setup.md の 2.）。

## 8. 特典ファイル

```bash
aws s3 cp <ファイル> s3://<Outputs の FilesBucket>/magnets/<ファイル名>
```

フォームの `lead_magnet` に `magnets/<ファイル名>` を書いて `pnpm tsuzuri sync`。

## 9. サンドボックスでのテスト

サンドボックス中は、SES で検証済みのアドレスにしか送れない。

1. SES のコンソールで、自分のメールアドレスを ID として追加し、届いた確認メールのリンクを押す。
2. `content/` のフォームを `active: true`、シナリオを `status: active` にして `pnpm tsuzuri sync`。
3. `https://mail.example.com/f/<フォームのslug>` から自分のアドレスで登録し、確認メール→特典→配信停止まで一通り試す。

## 10. 本番利用の申請

docs/ses-setup.md のチェックリストをすべて満たしてから、SES のコンソールの「本番アクセスをリクエスト」から申請する。申請文の草案も docs/ses-setup.md にある。

## 費用の目安（読者 1 万人に週 1 回配信した場合）

- SES：送信 1,000 通あたり 0.10 USD で、月 4〜5 USD 程度（予算アラート 5 USD に近いので、規模が増えたら予算を見直す）
- Lambda・SQS・SNS・EventBridge・S3：個人規模では無料枠内に収まる見込み（無料枠の条件は AWS の公式ページで確認）
- API Gateway（HTTP API）：リクエスト数に応じた従量課金
- データベース：Supabase の無料プランなら 0 円（容量 500MB まで）。毎晩 S3 にも書き出す

正確な金額は、1 か月使ったあとに AWS の請求画面で確認する。

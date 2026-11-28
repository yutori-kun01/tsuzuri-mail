# Cloudflare Workers で動かす（本番の標準構成）

tsuzuri-mail の本番は **Cloudflare Workers ＋ Supabase（PostgreSQL）＋ Amazon SES** で動かす。
VPS 版（`docs/vps.md`）と Lambda 版（`docs/aws-runbook.md`）は旧構成として残している（VPS からの移行元）。

```
読者のブラウザ ──HTTPS──▶ Worker「tsuzuri」（*.workers.dev）
                            ├─ 公開ページ（登録・確認・配信停止・配信設定・特典・計測・Web 版・特商法の表記）
                            ├─ 決済の通知 /hooks/stripe
                            ├─ Cron 毎分：自動化 → シナリオ・一斉配信を送信待ちに → SES のイベント → 送信
                            └─ Cron 毎日 18:00 UTC（日本時間 3:00）：スコア・バックアップ・古いデータの削除
管理者のブラウザ ──Access──▶ Worker「tsuzuri-admin」（*.workers.dev。Cloudflare Access で守る）
                            └─ 管理画面
両方 ──Hyperdrive──▶ Supabase の PostgreSQL（読者データの正本）
     ──R2──▶ tsuzuri-files（特典・商品のファイル）／ tsuzuri-backups（毎晩のバックアップ。暗号化）
     ──HTTPS（SigV4）──▶ Amazon SES（送信）／ SQS（バウンス・苦情。SNS → SQS は今のまま）
```

- コードは 1 つ。`SURFACES`（`public` / `admin`）で、読者向けと管理画面の Worker に分けて載せる。
- 入り口は `packages/server/src/workers/index.ts`、設定は `deploy/cloudflare/wrangler.jsonc`。
- メールの送信は `MailProvider`（`providers/aws-http.ts` の `SesHttpProvider`）越しだけ。AWS SDK は Worker に載せない。
- 二重送信の防止は、今までどおり DB の一意制約（`messages.idempotency_key` と、送信前の `queued → sending` の更新）。

## 費用の目安（2026-11 時点）

| 項目 | 月額 | 備考 |
|---|---|---|
| Cloudflare Workers Paid | 5 ドル | アカウントごと。Workers・Hyperdrive・Cron を含む。Worker を 2 つにしても同じ |
| R2 | 0 円の見込み | 無料枠は Standard で 10GB・Class A 100 万回・Class B 1,000 万回／月。バックアップの量は下の「容量」 |
| Supabase | Free 0 円／Pro 25 ドル | Free は 1 週間ほど使われないと一時停止・自動バックアップなし・500MB まで（バックアップは R2 で取る） |
| Amazon SES | 1,000 通あたり 0.10 ドル | 送った分だけ |
| Stripe（使うとき） | 月額 0 円 | 国内カードは決済ごとに 3.6% |

Workers の Free プランでは足りない：1 回の処理の CPU 時間が 10 ミリ秒までで、管理画面のパスワード照合（scrypt）だけで約 100 ミリ秒かかる（手元の workerd で測定）。毎分の送信も 10 ミリ秒には収まらない。

## 準備するもの

- Cloudflare のアカウント（ほかのツールとは別のアカウント）と Workers Paid
- Supabase のプロジェクト（今の DB）。「Direct」の接続文字列（Pooler ではない方）
- AWS：今の SES の ID・設定セット・SNS → SQS はそのまま使う。Workers 用の IAM ユーザーを足す（下の 4）
- 手元：Node.js 22 と pnpm。`pnpm install` 済み

## 構築の手順

### 1. DB の構造を最新にする（手元から）

```bash
DATABASE_URL='<Supabase の Direct の接続文字列>' pnpm tsuzuri migrate
```

Worker はマイグレーションを実行しない（ファイルを読めないため）。版を上げたら、デプロイの前に手元で `migrate` する。

### 2. Hyperdrive と R2 を作る

```bash
pnpm wrangler login
```

```bash
pnpm wrangler hyperdrive create tsuzuri-db --connection-string='<Supabase の Direct の接続文字列>'
```

表示された id を `deploy/cloudflare/wrangler.jsonc` の `REPLACE_WITH_HYPERDRIVE_ID`（2 か所）に入れる。

```bash
pnpm wrangler r2 bucket create tsuzuri-files
```

```bash
pnpm wrangler r2 bucket create tsuzuri-backups
```

### 3. 設定（vars）を直す

`deploy/cloudflare/wrangler.jsonc` の `vars`：

| 名前 | 中身 |
|---|---|
| `PUBLIC_BASE_URL` | **読者向けの** Worker の workers.dev の URL（初回のデプロイで表示される）。管理画面の Worker にも同じ値を入れる（管理画面から送るメールの配信停止リンクなどが、読者向けの Worker を向くように） |
| `ADMIN_BASE_URL` | 管理画面の Worker の workers.dev の URL（`env.admin` だけ）。パスキーはこのホスト名に結びつく |
| `LINK_BASE_URL` | メール本文のリンクの基点（任意）。空なら `PUBLIC_BASE_URL`。両方の Worker で同じ値にそろえる |
| `SES_EVENTS_QUEUE_URL` | CDK の出力 `SesEventsQueueUrl` |
| `MAX_SEND_RATE` | SES の送信レート（通/秒）以下 |
| `CORS_ORIGINS` | 別のサイトのページから fetch で登録 API を呼ぶときだけ（例 `https://example.com`） |
| `ACCESS_TEAM_DOMAIN`・`ACCESS_AUD` | Cloudflare Access の設定（下の 6）。入れると Worker 側でも Access の JWT を確かめる |
| `ADMIN_PASSWORD_LOGIN` | `off` でパスワード＋認証アプリのログインを止める（パスキーだけ） |

### 4. AWS：Workers 用の IAM ユーザー

`infra/tsuzuri.local.json` に `"tsuzuri:workersUser": "true"` を足して、**差分を確かめてから**デプロイする（オーナーの承認を得てから）。

```bash
cd infra && npx cdk diff
```

VPS 用ユーザー（`tsuzuri-vps`）の権限は変わらず、`tsuzuri-workers` が増えるだけになっていることを確かめる。権限は VPS 用と同じ（自分の送信ドメインからの SES 送信、SES のイベントのキューの受信・削除、SES の状態の読み取り）。Workers の送信元の IP は決まっていないので、IP では絞らない。アクセスキーは `aws iam create-access-key --user-name tsuzuri-workers` で作り、下の secret に入れる。

### 5. 秘密値（secret）を入れる

ファイルに書かない。1 つずつ入れる（`--env admin` を付けると管理画面の Worker に入る。両方に入れるものは 2 回）。

| 名前 | 読者向け | 管理画面 | 中身 |
|---|---|---|---|
| `TOKEN_SECRET` | ○ | ○ | **VPS と同じ値**（送ったメールの配信停止リンクを使い続けるため） |
| `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY` | ○ | ○ | `tsuzuri-workers` のアクセスキー |
| `BACKUP_ENCRYPTION_KEY` | ○ | ○ | `pnpm tsuzuri backup:key` で作る。パスワード管理アプリにも保管する（失うと復元できない） |
| `STRIPE_WEBHOOK_SECRET` | ○ | | Stripe の Webhook の署名シークレット（販売を始めるとき） |
| `ADMIN_PASSWORD_HASH`・`ADMIN_TOTP_SECRET` | | ○ | `pnpm tsuzuri admin:setup --local` で作ったもの |

```bash
pnpm wrangler secret put TOKEN_SECRET -c deploy/cloudflare/wrangler.jsonc
```

```bash
pnpm wrangler secret put TOKEN_SECRET -c deploy/cloudflare/wrangler.jsonc --env admin
```

### 6. デプロイと Cloudflare Access

```bash
pnpm cf:deploy
```

管理画面の Worker（`tsuzuri-admin`）の workers.dev に Cloudflare Access をかけ、自分だけが入れるようにする。読者向けの Worker（`tsuzuri`）には**かけない**（かけると登録フォームや配信停止が止まる）。

- Access のアプリケーションの AUD タグとチームのドメインを、`env.admin.vars` の `ACCESS_AUD`・`ACCESS_TEAM_DOMAIN` に入れて、もう一度デプロイする。Worker が Access の JWT を確かめるので、Access の設定の漏れやパスの書き方の違いがあっても、管理画面には入れない。
- パスキーは管理画面のホスト名（`ADMIN_BASE_URL`、`tsuzuri-admin.….workers.dev`）に結びつく。VPS で登録したものは使えないので、移行のときに 1 回登録し直す（古いものは「パスキー」の画面で消す）。
- パスキーを登録したら `ADMIN_PASSWORD_LOGIN` を `off` にすると、パスワード＋認証アプリのログインを止められる。パスキーが 1 つも無い間は、締め出さないよう `off` でも受け付ける。

1 つの Worker にまとめる場合は、`vars.SURFACES` を `public,admin` にして `env.admin` を使わない。そのときは Access を `/admin` のパスだけにかけ、`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD` を必ず入れる。

### 7. 確かめる

```bash
curl -s https://<読者向けの Worker>/health
```

管理画面で「設定」「送信ドメイン」「バックアップ」を開き、手元で `pnpm tsuzuri doctor` を実行する（`DATABASE_URL` は Supabase、`PUBLIC_BASE_URL` は読者向けの Worker）。

## 毎分・毎晩の処理

- 毎分：自動化 → シナリオ・一斉配信を送信待ちに → SES のイベント（最大 100 件）→ 送信。送信は `SEND_WINDOW_SECONDS`（既定 45 秒）の間、`MAX_SEND_RATE` を超えない速さで送り、残りは次の回に回す。1 時間に送れるのは多くても `MAX_SEND_RATE × 45 ÷ 1.1 × 60` 通ほど（`MAX_SEND_RATE` が 1 なら約 2,400 通。送信の間隔に 1 割の余裕を取っているため）。
- 確認メールと、登録完了の直後のシナリオの 1 通目は、応答のあと（`waitUntil`）にすぐ送る。
- Cron どうしが重なっても、送信の前に `queued → sending` を DB で更新できたものだけを送るので、二重には送らない。

## バックアップ（Supabase → R2）

- 毎晩 3 時（日本時間）に、全部の表（送信記録・行動履歴を含む）を表ごと 5,000 行ずつに分け、`BACKUP_ENCRYPTION_KEY` で暗号化して `tsuzuri-backups` に置く（`backups/<日付>/…`）。最後に `manifest.tzx` を書いたら完了。保存期間（`BACKUP_KEEP_DAYS`、既定 30 日）を過ぎた日は消す。
- 1 つの読み取り専用トランザクションの中で読むので、表どうしの中身はそろう。Workers のメモリ（128MB）に収まるよう、全部を 1 つにまとめない。
- 管理画面の「バックアップ」で、保存している量・30 日分の見込み・R2 の無料枠に対する割合を見られる。今すぐ取ることもできる。

### 容量の目安（手元で測定）

| データ | 1 日分の大きさ |
|---|---|
| 読者 5,000 人・送信記録 12 万件・行動履歴 30 万件 | 約 5.7MB（30 日分で約 172MB） |

R2 の無料枠（10GB）の 2% 未満。読者が 10 倍になっても無料枠に収まる見込み。

### 復元

1. 管理画面の「バックアップ」で日付を選んでダウンロードする（暗号化したまま 1 つのファイル `.tzb`）。
2. 手元で、復元先の DB と鍵を環境変数で渡して読み込む（鍵はコマンドの引数に書かない）。

```bash
DATABASE_URL='<復元先>' BACKUP_ENCRYPTION_KEY='<TZK1-…>' TOKEN_SECRET='<元と同じ値>' pnpm tsuzuri backup:restore tsuzuri-backup-2026-11-28.tzb --yes
```

`--yes` を付けないと、中身を確かめて表示するだけで何も変えない。読者 5,000 人ぶりのデータ（43 万行）で約 18 秒だった。

## 手元で動かす（wrangler dev）

```bash
pnpm cf:dev
```

- DB は `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` で手元の PostgreSQL を指す。R2 は手元に作られる。
- 秘密値は `deploy/cloudflare/.dev.vars`（コミットしない）に書く。**`$` は `\$` と書く**（`.dev.vars` では `$` が変数として展開され、`ADMIN_PASSWORD_HASH` が壊れる。`wrangler secret put` では起きない）。
- `MAIL_PROVIDER = "console"` にすると、送らずにログに出す。
- Cron は `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`（毎晩の分は `cron=0+18+*+*+*`）。

## オーナーが確かめること（コードからは分からない）

- 管理画面の Worker の workers.dev に、Cloudflare Access をかけられるか（Worker ごとの設定）。かけられない場合は、ログイン（パスワード＋認証アプリ・パスキー）だけで守ることになる。
- Supabase の Free で、毎分の Cron の読み書きが「使われている」と数えられ、一時停止しないか（念のため、止まったときの通知を確かめる）。
- Stripe の Payment Link に入れたメタデータ（`tsuzuri_product`）が Checkout Session に引き継がれるか（テストモードで確かめる）。

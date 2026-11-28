# Xserver VPS での運用（旧構成）

> 本番の標準構成は Cloudflare Workers に移した（[cloudflare.md](cloudflare.md)）。この手順は、移行元の VPS を動かし続ける間と、移行の作業のために残している。

本番は Xserver VPS で動かす。AWS は SES まわり（送信とバウンス・苦情の受け取り）だけに使う。
動かし方は **Docker 版（標準）** と、Docker を使わない **systemd 版** の 2 通りある。どちらもアプリの中身は同じ。

```
読者のブラウザ ──HTTPS──▶ リバースプロキシ（Caddy など、証明書は自動）──▶ tsuzuri（VPS の 127.0.0.1:8787）
                                                          │  ├─ 公開ページ・管理画面
                                                          │  ├─ 毎分：シナリオ・一斉配信を送信待ちに
                                                          │  ├─ 送信ワーカー ──▶ Amazon SES ──▶ 読者のメール
                                                          │  ├─ SES のイベント ◀── SQS ◀── SNS ◀── SES（バウンス・苦情）
                                                          │  └─ 毎日 3:00：スコア・バックアップ・古いデータの削除
                                                          └──▶ PostgreSQL（Supabase、または VPS 上）
```

公開ホストは `mail.example.com`（送信ドメインと同じ。DKIM・MAIL FROM のレコードとはぶつからない）。

## 構成要素（Docker 版）

| 要素 | 場所 | 中身 |
| --- | --- | --- |
| コード | クローンした場所（例：`~/tsuzuri-mail`） | `Dockerfile`、`deploy/docker/compose.yml` |
| tsuzuri 本体 | コンテナ `tsuzuri-tsuzuri-1` | `packages/server/src/vps/main.ts`。1 つのプロセスですべて動く。VPS の `127.0.0.1:8787` だけに公開 |
| 設定・秘密値 | `~/tsuzuri/tsuzuri.env`（600） | DB 接続、署名用の鍵、管理画面のログイン情報、AWS のアクセスキー。雛形は `deploy/vps/tsuzuri.env.example` |
| CA 証明書 | `~/tsuzuri/supabase-ca.crt` | Supabase を使う場合（公開情報） |
| 特典ファイル | `~/tsuzuri/data/files` | 署名付き・10 分で切れるリンクでだけ配る |
| バックアップ | `~/tsuzuri/data/backups` | 毎晩、主要な表を書き出し（30 日保存） |
| HTTPS | リバースプロキシ | Let's Encrypt の証明書を自動で取得・更新（例：`deploy/vps/Caddyfile`） |
| AWS | CDK の `TsuzuriVps` スタック（`infra/`） | 設定セット、SNS → SQS、IAM ユーザー `tsuzuri-vps`、アラーム |

`~/tsuzuri` は `TSUZURI_HOME` で変えられる。コンテナは init.sh を実行したユーザーの UID・GID で動き、設定は読み取り専用、書き込めるのは `~/tsuzuri/data` だけ（root 権限なし、ファイルシステムは読み取り専用）。

## 初回の構築

### 1. AWS 側（手元のパソコンから）

先に、自分の環境の値（ドメイン、送信用サブドメイン、公開ホストなど）を `infra/tsuzuri.local.json` に書きます。`infra/tsuzuri.local.example.json` をコピーして直してください。このファイルはコミットされず、`infra/cdk.json` の値より優先されます。

```bash
cp infra/tsuzuri.local.example.json infra/tsuzuri.local.json
```

```bash
cd infra && AWS_PROFILE=tsuzuri TSUZURI_VPS_IP="<VPS の IPv4 アドレス>" TSUZURI_ALERT_EMAIL="<通知先>" npx cdk deploy TsuzuriVps
```

- `TSUZURI_VPS_IP` を指定すると、アクセスキーはその IP からしか使えない（漏れたときの被害を抑える）。
- **IPv6 について**：アプリが使う AWS SDK は、既定で IPv4 のエンドポイントにつなぐ（デュアルスタックは使わない設定）。そのため通常は IPv4 だけで足りる。`AWS_USE_DUALSTACK_ENDPOINT` などで IPv6 を使う構成にした場合や、送信で `AccessDenied` が出て IPv6 から出ていると分かった場合は、`TSUZURI_VPS_IPV6="<VPS の IPv6 アドレス>"` も付けて再デプロイする。
- **サンドボックス中の権限**：`infra/tsuzuri.local.json` の `tsuzuri:sesSandbox` が `true`（既定）の間は、テスト用に検証した宛先の ID への送信も許可するため、送信の権限を「このアカウント・東京リージョンの SES の ID すべて」にしている。送信元（`@mail.example.com`）と接続元（VPS の IP）の制限はそのまま。本番承認後は `false` にして再デプロイし、送信ドメインの ID だけに絞る。
- Outputs の `SesEventsQueueUrl` を控える。
- アクセスキーを作る（表示された 2 つの値は、次の手順で VPS の設定ファイルに直接書く。チャットやファイルに残さない）：

```bash
aws iam create-access-key --profile tsuzuri --user-name tsuzuri-vps
```

### 2. DNS（Xserver の DNS レコード設定）

`mail.example.com` の A レコードを VPS の IPv4 アドレスに向ける（ホスト名 `ml`）。既にある DKIM（`*._domainkey.ml`）、MAIL FROM（`bounce.ml`）、DMARC（`_dmarc.ml`）のレコードは消さない。

### 3. コードの取得（VPS に SSH でログインして）

リポジトリは非公開なので、VPS で読み取り専用のデプロイキーを作り、GitHub のリポジトリの Settings → Deploy keys に登録する（「Allow write access」は付けない）：

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/tsuzuri_deploy -C tsuzuri-vps
```

```bash
cat ~/.ssh/tsuzuri_deploy.pub
```

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/tsuzuri_deploy -o IdentitiesOnly=yes" git clone --branch main git@github.com:<GitHub のユーザー名>/tsuzuri-mail.git ~/tsuzuri-mail
```

```bash
git -C ~/tsuzuri-mail config core.sshCommand "ssh -i ~/.ssh/tsuzuri_deploy -o IdentitiesOnly=yes"
```

### 4. 初回の準備（設定ファイルとデータの置き場所）

Docker と docker compose（v2）が入っていることが前提。普段のユーザー（root ではない、docker を使える）で実行する：

```bash
bash ~/tsuzuri-mail/deploy/docker/init.sh
```

`~/tsuzuri/tsuzuri.env`（署名用の鍵は生成済み）と `~/tsuzuri/data/` ができる。

### 5. 設定ファイル

```bash
nano ~/tsuzuri/tsuzuri.env
```

`DATABASE_URL`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`SES_EVENTS_QUEUE_URL`、`MAIL_FROM_NAME`、`MAIL_CONTACT`、`PRIVACY_URL` などを埋める。`PUBLIC_BASE_URL` は `https://mail.example.com`。`TOKEN_SECRET` は init.sh が作成済み。**作り直さない**（送信済みメールの配信停止リンクが無効になる）。
Supabase を使う場合は CA 証明書を `~/tsuzuri/supabase-ca.crt` に置く（`DATABASE_CA_FILE` は init.sh が `/config/supabase-ca.crt` にしてある）。

### 6. HTTPS（リバースプロキシ）

`mail.example.com` への HTTPS を `127.0.0.1:8787` に転送する。

- VPS に Caddy を直接入れている場合：`deploy/vps/Caddyfile` の内容を `/etc/caddy/Caddyfile` に入れて `sudo systemctl reload caddy`。
- 既にリバースプロキシをコンテナで動かしている場合：そのプロキシから VPS の `127.0.0.1:8787` に届くように設定する（プロキシのコンテナが host ネットワークでないなら、`host.docker.internal:8787` を使い、プロキシ側に `extra_hosts: ["host.docker.internal:host-gateway"]` を足す。または compose.yml の `ports` を外して、プロキシと同じ Docker ネットワークに `tsuzuri` を参加させる）。
- ファイアウォールは SSH・80・443 だけ開ける。8787 は外に開けない。

#### VPS 専用の compose ファイルを重ねる（プロキシのネットワークに参加させる場合など）

`compose.yml` は変えずに、VPS 専用のファイル（例 `deploy/docker/compose.npm.yml`）を作って重ねる。リポジトリには含めない（`.git/info/exclude` に足す）。例（プロキシが外部ネットワーク `npm_network` にいる場合）：

```yaml
services:
  tsuzuri:
    networks:
      default: {}
      npm_network:
        aliases:
          - tsuzuri-mail
networks:
  npm_network:
    external: true
```

プロキシの転送先は `http://tsuzuri-mail:8787`。`deploy.sh` に読ませるには、`deploy/docker/.env`（init.sh が作る。リポジトリに含めない）に 1 行足す（空白区切りで複数可。`deploy/docker` からの相対パスか絶対パス）：

```bash
echo 'TSUZURI_COMPOSE_EXTRA=compose.npm.yml' >> ~/tsuzuri-mail/deploy/docker/.env
```

環境変数 `TSUZURI_COMPOSE_EXTRA` で渡しても良い（`.env` より優先）。`deploy.sh` は「== 追加の compose ファイル：…」と表示する。init.sh を再実行してもこの行は残る。
手で `docker compose` を実行するときも同じファイルを重ねる（`-f deploy/docker/compose.yml -f deploy/docker/compose.npm.yml`）。重ねずに `up` するとプロキシのネットワークから外れる。

### 7. 起動

```bash
bash ~/tsuzuri-mail/deploy/docker/deploy.sh
```

イメージを作り、起動し、`/health` の応答まで確認する（「起動しました」で終わる）。起動時に DB の構造も自動で最新になる。

### 8. 管理画面のログイン情報

パスワードの入力と認証アプリへの登録はオーナーが行う：

```bash
cd ~/tsuzuri-mail && docker compose -f deploy/docker/compose.yml run --rm cli admin:setup --local --env-file /config/tsuzuri.env
```

設定ファイルを読み直させるため、**restart ではなく作り直す**：

```bash
cd ~/tsuzuri-mail && docker compose -f deploy/docker/compose.yml up -d --force-recreate tsuzuri
```

`https://mail.example.com/admin` にログインし、「設定」で送信者名・問い合わせ先・住所（または送信者情報ページ）・テスト送信先を入れる。

## 日々の運用（Docker 版）

以下は `cd ~/tsuzuri-mail` してから実行する。`C="docker compose -f deploy/docker/compose.yml"` としておくと短く書ける。

| やりたいこと | コマンド |
| --- | --- |
| 最新のコードにする | `bash deploy/docker/deploy.sh` |
| 状態を見る | `docker compose -f deploy/docker/compose.yml ps` |
| ログを見る | `docker compose -f deploy/docker/compose.yml logs -f tsuzuri` |
| 設定ファイルを変えたあと | `docker compose -f deploy/docker/compose.yml up -d --force-recreate tsuzuri` |
| 自己点検 | `docker compose -f deploy/docker/compose.yml run --rm cli doctor --http` |
| サンプルなどを DB に反映 | `docker compose -f deploy/docker/compose.yml run --rm cli sync /app/content` |
| 特典ファイルを置く | `install -m 600 <ファイル> ~/tsuzuri/data/files/magnets/` |
| 既存リストの取り込み | 管理画面の「読者」→「CSV で取り込む」（おすすめ）。コマンドなら CSV を `~/tsuzuri/data/` に置き、`docker compose -f deploy/docker/compose.yml run --rm cli import /data/<file.csv> --label <名前> --evidence <同意の取得方法>` |
| 本番承認後に送信速度を上げる | `~/tsuzuri/tsuzuri.env` の `MAX_SEND_RATE` を承認値にして、作り直す（上の「設定ファイルを変えたあと」） |

## 別のドメインから送る（シナリオ・一斉配信ごとの送信者）

シナリオ設定と一斉配信の「送信者を変える」で、送信者名・送信元アドレス・返信先を変えられます。空欄なら「設定」の送信者で送ります。フォームの確認メールは、そのフォームが始めるシナリオの送信者で送ります。

既定の送信ドメイン（例 `mail.example.com`）以外のアドレスから送るときは、先にドメインを登録します。

1. 管理画面の「設定 → 送信ドメイン」で、ドメイン（例 `news.example.jp`。送信専用のサブドメインがおすすめ）を追加する。
2. 【オーナー・PC 側】`infra/tsuzuri.local.json` の `"tsuzuri:extraSendingDomains"` に同じドメインを足し（例 `["news.example.jp"]`）、`TsuzuriVps` をデプロイする。SES にドメインの ID（Easy DKIM、MAIL FROM は `bounce.<ドメイン>`）が作られ、VPS の鍵がそのドメインから送れるようになる。
3. 「送信ドメイン」を開き直すと、DNS に入れるレコード（DKIM 3 本、MAIL FROM の MX と SPF、DMARC）がコピーボタン付きで出るので、そのドメインの DNS に登録する。
4. 状態が「送信できます」（DKIM・MAIL FROM とも成功）になったら、シナリオや一斉配信の送信元アドレスに使う。自己点検（`doctor`）も追加したドメインを確認する。

VPS の鍵には SES の ID を作る権限を持たせていません（鍵が漏れたときに勝手なドメインを登録されないように）。そのため、AWS 側の登録はデプロイで行います。新しいドメインは評判がゼロからなので、最初は少ない通数から送り始めてください。

## 動作確認だけしたいとき

`~/tsuzuri/tsuzuri.env` に `MAIL_PROVIDER=console` を書いて作り直すと、メールを送らずにログへ出す。確認が終わったら消して、もう一度作り直す。

## バックアップを VPS の外にも置く（推奨）

`~/tsuzuri/data/backups` は VPS のディスクなので、VPS ごと失うと消える。Supabase を使っている場合は Supabase 側にもデータがあるが、念のため定期的に手元へ取得する：

```bash
scp -r <ユーザー>@<VPS>:tsuzuri/data/backups ./tsuzuri-backups
```

## systemd 版（Docker を使わない場合）

`deploy/vps/` の setup.sh・deploy.sh・tsuzuri.service を使う。設定は `/etc/tsuzuri/tsuzuri.env`、データは `/var/lib/tsuzuri/`、コードは `/opt/tsuzuri/app`。

1. 上の 3 と同じ要領で、`/opt/tsuzuri/app` にクローンする（`sudo` を付け、鍵は `/root/.ssh/tsuzuri_deploy`）。
2. 初期設定（Node.js 22、Caddy、実行ユーザー、ディレクトリ、ファイアウォール、自動のセキュリティ更新）：`sudo bash /opt/tsuzuri/app/deploy/vps/setup.sh`
3. `/etc/tsuzuri/tsuzuri.env` を埋め、CA 証明書を `/etc/tsuzuri/supabase-ca.crt` に置く（root:tsuzuri、640）。
4. 起動：`sudo bash /opt/tsuzuri/app/deploy/vps/deploy.sh`
5. 管理画面：`cd /opt/tsuzuri/app && sudo pnpm tsuzuri admin:setup --local --env-file /etc/tsuzuri/tsuzuri.env` のあと `sudo systemctl restart tsuzuri`
6. ログ：`journalctl -u tsuzuri -f`

## セキュリティ

- アプリは VPS の 127.0.0.1 だけで待ち受け、外からはリバースプロキシ（443 番）経由でしか届かない。ファイアウォールは SSH・80・443 だけ開ける。
- Docker 版：root ではないユーザーで動かし、ファイルシステムは読み取り専用、特権（capabilities）はすべて外し、設定は読み取り専用で渡す。書き込めるのは `~/tsuzuri/data` だけ。設定を書き換えられるのは管理用の `cli` だけ。
- systemd 版：systemd で権限を絞っている（書き込めるのは `/var/lib/tsuzuri` だけ、特権なし）。
- AWS のアクセスキーは送信と SES イベントの受け取りしかできず、送信元は `@mail.example.com`、接続元は VPS の IP に限られる。
- フォームの送信・管理画面のログインは IP ごとに 1 分 10 回まで（アプリ内で制限）。
- SSH はパスワードログインを無効にし、鍵認証だけにすることを推奨（Xserver VPS のパネルで鍵を登録してから `/etc/ssh/sshd_config` の `PasswordAuthentication no`）。

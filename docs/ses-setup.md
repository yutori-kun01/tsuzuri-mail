# Amazon SES の準備と本番利用の申請

方針：**仕組みを実際に動く状態まで作り、サンドボックスで通しテストを済ませてから申請する。申請文には、実際に動いていることだけを書く。**
前回の申請で通らなかったことを踏まえ、下の「申請前チェックリスト」がすべて埋まるまで申請しない。

- リージョン：東京（ap-northeast-1）
- 送信ドメイン：`mail.example.com`（本体ドメインの評判を配信の影響から切り離すためのサブドメイン）
- From：`info@mail.example.com`
- 本番の実行環境：Xserver VPS（docs/vps.md）。AWS は SES と、バウンス・苦情の受け取り（SNS → SQS）だけに使う
- DNS：Xserver で管理

## 1. 済んでいること

- [x] AWS アカウント、AWS Budgets（月 5 USD）
- [x] SES の ID `mail.example.com`（Easy DKIM、RSA 2048）、カスタム MAIL FROM `bounce.mail.example.com`、DMARC `_dmarc.mail.example.com`
- [x] アプリ：ダブルオプトイン、配信停止（ワンクリック）、配信設定ページ、バウンス・苦情の自動処理、休眠読者の再確認と自動停止、法定表示（docs/content.md）

## 2. 申請前チェックリスト

自己点検コマンドで、ほとんどの項目を自動で確かめられる。VPS 上で実行する（AWS のアクセスキーと公開 URL が使える環境のため）：

```bash
cd ~/tsuzuri-mail && docker compose -f deploy/docker/compose.yml run --rm cli doctor --http
```

`✗` が 0 件になり、`!` の内容も納得できる状態にしてから申請する。

| 項目 | 自己点検 | 補足 |
| --- | --- | --- |
| SES の ID が検証済み（DKIM・MAIL FROM とも成功） | ✓ 自動 | |
| アカウント単位の抑制リスト（BOUNCE・COMPLAINT） | ✓ 自動 | `aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT` |
| 設定セット `tsuzuri` にバウンス・苦情のイベント送信先がある | ✓ 自動 | `infra/` の `TsuzuriVps` をデプロイすると作られる |
| バウンス・苦情の受け取り（SQS）が設定済み | ✓ 自動 | `SES_EVENTS_QUEUE_URL` |
| 法定表示（送信者名・問い合わせ先・住所またはそのページ） | ✓ 自動 | 管理画面の設定 |
| 受付中のフォームがダブルオプトインで、プライバシーポリシーがある | ✓ 自動 | **プライバシーポリシーのページは自分のサイトに用意する** |
| 休眠読者の再確認シナリオが有効 | ✓ 自動 | 管理画面のシナリオ |
| 公開 URL が https で、`/health` と `/legal` が表示できる | ✓ 自動（`--http`） | |
| サンドボックスで、検証済みのアドレスに実物を送り、登録→確認→特典→配信設定→配信停止まで確かめた | 手動 | 指示書のフェーズ I |
| 受信したメールのソースで `dkim=pass`・`spf=pass`・`dmarc=pass` | 手動 | Gmail の「メッセージのソースを表示」 |
| 申請文の送信量を、実際の見込みに書き換えた | ✓ 手動（2026-11-16：月 3,000 通程度・1 日最大 200〜300 通） | 下の 3. |

## 3. 申請の入力内容

SES のコンソール（東京リージョン）→「アカウントダッシュボード」→「本番アクセスをリクエスト」。

| 欄 | 入力する内容 |
| --- | --- |
| メールタイプ | **マーケティング**（ニュースレターとステップ配信のため） |
| ウェブサイトの URL | `https://example.com/lp/newsletter/`（SES で送るメルマガ専用の登録ページ。ダブルオプトインのフォーム・同意文・プライバシーポリシーへのリンクがある） |
| ユースケースの説明 | 下の英文（送信量は 2026-11-16 にオーナーの見込みに合わせ済み） |
| 追加の連絡先・言語 | 任意。言語は英語か日本語 |
| 規約への同意 | AWS の利用規約とサービス規約を読んでから同意する |

### ユースケースの説明（英文・そのまま貼れる形）

```
I am an independent writer in Japan (site name: "<サイト名>", example.com). I will use Amazon SES to send my own newsletter, "<メルマガ名>", and a two-week welcome series to readers who sign up for it on my website. The emails are written in Japanese. I only send my own content; I do not send email on behalf of anyone else.

How recipients are collected:
- Only through the signup form for this newsletter: https://example.com/lp/newsletter/ (the same form is also available at https://mail.example.com/f/newsletter). Every signup uses double opt-in: an address is added only after the reader clicks the confirmation link we email to them.
- The form states who the sender is, that the newsletter includes promotional content, and links to the privacy policy and the sender information page.
- For each signup I store the time, the form, and the version of the consent wording shown, as required by Japan's Act on Regulation of Transmission of Specified Electronic Mail.
- I never buy, rent, share or scrape lists. This is a new list that starts from zero. Addresses collected earlier with other tools are not imported; those readers can join only by signing up again through the double opt-in form.
- The form is protected against abuse: rate limits per IP address, a hidden honeypot field, an allow-list of the sites that may embed the form, and at most three confirmation emails per address per day.

Volume:
- The list starts from zero and grows gradually. I expect about 100 new subscribers per month at first.
- Each new subscriber receives a welcome series during their first two weeks (up to two short emails per day). After that, they receive the regular newsletter, about once a week at most.
- I expect about 3,000 messages per month and at most 200 to 300 messages per day during the first three months. The default production quota is more than enough; I am not requesting a specific increase.
- My sender paces messages to stay under the account's maximum send rate.

Bounces and complaints:
- A configuration set publishes delivery, bounce, complaint and reject events to Amazon SNS, which delivers them to an Amazon SQS queue that my application reads continuously.
- A hard bounce or a complaint permanently stops all mail to that address immediately. Three consecutive soft bounces pause the address.
- Both the account-level suppression list and the configuration set's suppression list are enabled for bounces and complaints.
- I monitor bounce and complaint rates with CloudWatch alarms and an in-app dashboard that warns before they approach the SES thresholds.

Unsubscribe and preferences:
- Every marketing message contains a visible unsubscribe link and the List-Unsubscribe and List-Unsubscribe-Post headers (RFC 8058 one-click unsubscribe). Unsubscribes take effect immediately and stop any scheduled messages.
- A preferences page lets readers choose which kinds of email they receive, or pause all email for 30 or 90 days.
- Readers who have not engaged for a long period stop receiving the newsletter. They receive one re-confirmation message, and if they do not respond, mailing to them stops automatically.

Authentication:
- The sending subdomain mail.example.com is verified with Easy DKIM (2048-bit), uses the custom MAIL FROM domain bounce.mail.example.com (SPF), and publishes a DMARC record.

Every message footer shows the sender's name, a contact address, a link to the sender information page (postal address), the unsubscribe link and the preferences link.

A sample message (the welcome email sent after a confirmed signup, in Japanese) is included below.
```

### サンプルメール（申請文の最後に続けて貼る）

`newsletter` フォームの登録後に届くようこそメール（`newsletter-welcome` シナリオ）のテキスト版。`<送信者名>` と `<問い合わせ先>` は、申請時に実際の値に置き換える。テストアドレスで実際に受け取ったものを貼るのが一番確実。

```
Subject: <メルマガ名>へようこそ

山田さん、<メルマガ名>にご登録いただきありがとうございます。<送信者名>です。

このメルマガでは、次のようなことをお届けしていきます。
- <届ける内容 1>
- <届ける内容 2>
- ブログの新しい記事、企画のご案内

配信は不定期です。受け取るメールの種類や、しばらくお休みする設定は、メール末尾の「配信設定」から変えられます。不要になったら「配信停止」からいつでも止められます。

――
<送信者名>（<サイト名>）

――――――――
送信者：<送信者名>
お問い合わせ：<問い合わせ先>
送信者情報（住所など）：https://mail.example.com/legal
配信停止：https://mail.example.com/u/<signed-token>
配信設定：https://mail.example.com/p/<signed-token>
```

### 日本語訳（確認用。申請には英文を使う）

> 日本の個人ライター（サイト名「<サイト名>」、example.com）です。Amazon SES で、自分のメルマガ「<メルマガ名>」と、サイトで登録した読者への 2 週間のようこそシリーズを送ります。メールは日本語です。自分のコンテンツだけを送り、他人の代わりに送ることはありません。
>
> **宛先の集め方**：このメルマガ専用の登録フォーム（https://example.com/lp/newsletter/、同じものが https://mail.example.com/f/newsletter にもある）だけ。すべてダブルオプトイン。フォームには送信者、広告・宣伝を含むこと、プライバシーポリシーと送信者情報へのリンクを表示。登録ごとに日時・フォーム・表示した同意文言の版を記録（特定電子メール法）。リストの購入・共有・収集はしない。ゼロから始める新しいリストで、ほかのツールで以前に集めたアドレスは取り込まない（ダブルオプトインのフォームから登録し直した人だけ）。フォームは、IP ごとの回数制限、見えない入力欄、埋め込みを許可するサイトの限定、同じアドレスへの確認メールは 1 日 3 通までで保護している。
>
> **送信量**：ゼロから徐々に増える見込みで、最初は新規登録が月 100 人程度。新しい登録者には最初の 2 週間、ようこそシリーズ（1 日最大 2 通の短いメール）を送り、その後は多くて週 1 回程度のメルマガを送る。最初の 3 か月は月 3,000 通程度、1 日最大 200〜300 通の見込み。本番の標準の上限で十分なので、特定の引き上げは求めない。送信は上限の速度を超えないように間隔を空ける。（2026-11-16 にオーナーの見込みに合わせた）
>
> **バウンス・苦情**：設定セットから配信・バウンス・苦情・拒否のイベントを SNS に送り、SQS 経由でアプリが常に読み取る。ハードバウンスと苦情は即座にそのアドレスへの送信を永久に止め、ソフトバウンスが 3 回続いたら一時停止する。アカウント単位と設定セットの抑制リストをどちらも有効化。バウンス率・苦情率は CloudWatch のアラームと管理画面で監視し、基準に近づく前に警告する。
>
> **配信停止と配信設定**：すべてのマーケティングメールに、見える配信停止リンクと List-Unsubscribe・List-Unsubscribe-Post ヘッダー（RFC 8058 のワンクリック配信停止）を入れる。停止は即時で、予約済みのメールも止める。配信設定ページで、受け取る種類を選んだり、30 日・90 日お休みしたりできる。長く反応のない読者にはニュースレターを止め、再確認のメールを 1 通送り、反応がなければ自動で送信を止める。
>
> **認証**：送信用サブドメイン mail.example.com は Easy DKIM（2048bit）で検証済み、カスタム MAIL FROM ドメイン bounce.mail.example.com（SPF）を使用し、DMARC を公開している。
>
> すべてのメールのフッターに、送信者名・連絡先・送信者情報ページ（住所）へのリンク・配信停止リンク・配信設定リンクを表示する。

## 4. 承認された後

1. 承認メールに書かれた送信上限（24 時間の通数、1 秒あたりの通数）を確認する。自己点検でも確認できる：

```bash
cd ~/tsuzuri-mail && docker compose -f deploy/docker/compose.yml run --rm cli doctor
```

2. VPS の `~/tsuzuri/tsuzuri.env` の `MAX_SEND_RATE` を、承認された「1 秒あたりの通数」以下にして、作り直す（restart では設定ファイルを読み直さない）：

```bash
cd ~/tsuzuri-mail && docker compose -f deploy/docker/compose.yml up -d --force-recreate tsuzuri
```

3. PC 側で `infra/tsuzuri.local.json` の `tsuzuri:sesSandbox` を `false` にして `TsuzuriVps` を再デプロイし、送信の権限を送信ドメインの ID だけに絞る（docs/vps.md）。

4. 最初の数週間は少人数から送り始め、管理画面のホームでバウンス率・苦情率を確認する。DMARC は運用が安定してから `p=quarantine` へ段階的に強める。

## 5. 追加の質問が来た場合・却下された場合

- 追加の質問が来たら、その内容を開発用のチャットに貼る。事実に基づいて回答文を作る。
- AWS の FAQ によれば、却下の理由は開示されず、サポート窓口も却下を覆せない。送信は `MailProvider` 越しに行う作りなので、別の送信サービスの実装を追加して開発を止めない。

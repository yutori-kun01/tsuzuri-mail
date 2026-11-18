# メール本文と置き換え文字の書き方

本文は **Markdown**（`.md`）か **HTML**（`.html`）で書く。

- Markdown：改行はそのまま改行になる。自動で読みやすいレイアウトに入る。
- HTML：書いた HTML をそのまま送る。`<html>〜</body>` まで書いた完全な HTML なら `</body>` の直前に、部分だけなら標準レイアウトに入れてからフッターを差し込む。テキスト版は HTML から自動で作る。
  - 置き換え文字は HTML の中でも使える（`<a href="%cancel%">`、`<img src="%lp_url%/hero.png">` など）。
  - メールソフトは `<style>` を無視することが多いので、装飾は `style="..."` で直接書くのが確実。

## 置き換え文字

`%名前%` のように `%` で挟んだ文字が、送信時に読者ごとの値に置き換わる。

### 組み込み

| 書き方 | 日本語の別名 | 中身 |
| --- | --- | --- |
| `%cancel%` | `%配信解除%` `%配信停止%` | 配信停止ページの URL（クリック計測しない） |
| `%settings%` | `%配信設定%` | 配信設定ページの URL |
| `%confirm%` | `%登録確認%` | 登録確認の URL（確認メール専用） |
| `%download%` | `%特典%` `%ダウンロード%` | 特典のダウンロード URL（押されると目標行動として記録） |
| `%webview%` | `%Web版%` | この号の Web 版 URL（一斉配信のみ。末尾まで読むと読了として記録） |
| `%name%` | `%名前%` `%呼び名%` | 読者の呼び名 |
| `%email%` | `%メールアドレス%` | 読者のメールアドレス |
| `%date%` | `%日付%` | 送信日（例：2026年11月13日） |
| `%sender%` | `%送信者%` | 送信者名 |
| `%contact%` | `%問い合わせ先%` | 問い合わせ先 |
| `%subscribed_date%` | `%登録日%` | 読者の登録日 |

### 値が空のときの代わり

`%name|読者%さん` と書くと、呼び名が未登録の読者には「読者さん」と表示される。

### 独自の置き換え文字

よく使う URL や定型文を登録しておける。

```bash
pnpm tsuzuri var:set lp_url https://example.com/lp --url
```

```bash
pnpm tsuzuri var:set 署名 "書き手より"
```

本文で `%lp_url%`、`%署名%` と書く。`content/variables.json` に書いて `pnpm tsuzuri sync` でもよい。
名前に空白・`%`・`|`・`.`・`:` は使えない。組み込みと同じ名前も使えない。

### 読者ごとの属性

CSV 取り込みの `attr.job` 列などに入れた値は `%attr.job%` で使える。

### 「%」そのものを書く

`50%%オフ` と `%` を 2 つ重ねる。`50% オフ` のように後ろに空白があれば、そのままでもよい。

### 打ち間違いの扱い

登録されていない置き換え文字（例：`%cancell%`）があると、`sync` で警告され、送信時もそのメールは送られずに失敗として記録される。置き換えられないまま読者に届くことはない。

## リンク

`[表示する文字](https://...)` と書く。配信停止・配信設定・特典以外のリンクは、自動でクリック計測される。
本文の最後のリンクのクリックは「読了」としても数える。最後に「続きを読む」や「ブログで詳しく」を置くと、読了の目安になる。

## 自動で付くもの

すべてのメールの末尾に、送信者名・問い合わせ先・「送信者情報（住所など）はこちら」のリンク・配信停止リンク・配信設定リンクが自動で入る（特定電子メール法の表示）。本文に書く必要はない。

住所はメール本文には出さず、リンク先のページに表示する（リンク先での表示は認められている。リンクは「送信者情報（住所など）」と分かる文言にしてある）。リンク先は `senderInfoUrl`（自分のサイトの特定商取引法の表示ページなど）、未設定なら `https://mail.example.com/legal`（`senderAddress` を表示する）。

送信者名・問い合わせ先・送信元、および住所（`senderAddress` か `senderInfoUrl` のどちらか）が未設定だと、メールは送信されない（設定されるまで送信待ちのまま残る）。

## フォーム（キャンペーン・メルマガごとに 1 ファイル）

`content/forms/<slug>.md`（確認メールを HTML で書くなら `.html`）。本文は確認メール（`%confirm%` が必須）。

| 項目 | 例 | 意味 |
| --- | --- | --- |
| `name` | `SEOチェックリスト` | 管理用の名前 |
| `sequence` | `seo` | 登録後に始めるシナリオ。メルマガだけのフォームなら書かない |
| `tag` | `src:seo` | 付けるタグ（省略時 `src:<slug>`） |
| `lead_magnet` | `magnets/seo.pdf` | 特典ファイル（`%特典%` のリンク先） |
| `page_title` / `page_description` | | 自前のフォームページの見出し・説明 |
| `button_label` | `無料で受け取る` | ボタンの文字（埋め込みフォームにも反映） |
| `sent_url` | `https://example.com/check-mail` | 送信直後に移動するページ。省略時は標準の「確認メールを送りました」ページ |
| `sent_message` | | 標準ページに出す文 |
| `thanks_url` | `https://example.com/thanks` | 登録確定後に移動するページ。省略時は標準の完了ページ |
| `confirmed_message` | | 標準の完了ページに出す文 |
| `privacy_url` | | フォームに出すプライバシーポリシー |
| `allowed_origins` | `["https://example.com"]` | 埋め込みフォームを置いてよいサイト。これ以外のサイトからの送信は拒否する |
| `confirm_subject` | | 確認メールの件名 |
| `active` | `true` | 受付中か |

URL はすべて `https://` で始める。

### 他のページに貼るフォームタグ

```bash
pnpm tsuzuri form:embed <slug>
```

出力された `<form>...</form>` を、ブログや LP の HTML にそのまま貼る。見た目は貼り付け先の CSS で整える（`tsuzuri-form`・`tsuzuri-input`・`tsuzuri-button` のクラスが付いている）。名前欄が不要なら `--no-name`。
デプロイ後は `https://mail.example.com/f/<slug>/embed` でも同じものが表示される。

## 配信設定（読者が選べること）

メール末尾の「配信設定」（`%settings%`）から、読者は次を選べる。

- **受け取るメールの種類**：管理画面の「配信の種類」（または `content/topics.json`）で作った種類ごとに、受け取る・受け取らないを選ぶ。一斉配信やシナリオに種類を設定すると、「受け取らない」を選んだ読者には届かない。種類を設定しないメールは、配信中の全員に届く。
- **しばらくお休みする**：30 日・90 日。お休みの間は一斉配信もシナリオも届かず、シナリオは再開日まで先送りされる。期間が終わると自動で再開する。
- **配信停止**：すべてのメールを止める（`%cancel%` と同じ）。

確認メールなど、登録の手続きに必要なメールは配信設定に関係なく届く。

`content/topics.json` の例：

```json
[
  { "slug": "newsletter", "name": "メルマガ本誌", "description": "定期的にお届けするメールマガジン", "default_subscribed": true },
  { "slug": "campaign", "name": "キャンペーン・お知らせ", "description": "特典や新しい企画のご案内", "default_subscribed": true }
]
```

`default_subscribed: false` にすると、「受け取る」を選んだ読者にだけ届く種類になる（先行案内など）。シナリオの `_sequence.md` に `topic: campaign` と書くと、そのシナリオの種類になる。

## シナリオのファイル

```
content/sequences/<シナリオ名>/
  _sequence.md      設定（name、status: draft/active、done_tag、purpose: reengage）
  01_xxx.md         1 通目（HTML で書くなら 01_xxx.html）
  02_xxx.md         2 通目
```

各ステップの先頭に書ける設定：

| 項目 | 例 | 意味 |
| --- | --- | --- |
| `subject` | `特典をお届けします` | 件名（置き換え文字が使える） |
| `delay_days` | `2` | 前の通から何日後に送るか（1 通目は登録からの日数） |
| `delay_hours` | `3` | 「○時間後」で送る（`delay_days`・`send_time` より優先。`0` ならすぐ） |
| `delay_minutes` | `30` | 「○分後」で送る（`delay_hours` と同じ。両方あれば `delay_minutes` を使う） |
| `send_time` | `"08:00"` | 送る時刻（日本時間）。省略すると前の通と同じ時刻 |
| `condition` | `{"minScore": 60}` | この条件に合う読者にだけ送る（合わない人は飛ばして次へ） |

`condition` に書ける条件：`minScore`、`maxScore`、`tiers`（例 `["hot","normal"]`）、`hasTags`、`lacksTags`。

## 送信者表示の設定（content/settings.json）

| 項目 | 意味 |
| --- | --- |
| `fromAddress` | 送信元アドレス（`info@mail.example.com` など） |
| `fromName` | 受信箱に表示される送信者名 |
| `replyTo` | 返信先（任意） |
| `senderName` | フッターに出す送信者の氏名・名称（法定表示） |
| `senderInfoUrl` | 住所などを載せた自分のページの URL（任意） |
| `senderAddress` | `senderInfoUrl` が無いときに `/legal` ページに出す住所（メール本文には出ない） |
| `contact` | フッターに出す問い合わせ先（法定表示） |
| `footerExtraLines` | フッターに追加する行（住所など） |
| `defaultName` | 呼び名が無い読者に使う呼び方 |

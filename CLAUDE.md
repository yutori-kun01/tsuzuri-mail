# tsuzuri-mail 開発ルール

個人ライター向けの小型MA。要件は docs/requirements.md（元の要件定義書へのリンクあり）。

## 方針
- 本番は Cloudflare Workers（入り口は packages/server/src/workers/、設定は deploy/cloudflare/wrangler.jsonc）＋ Supabase の PostgreSQL（Hyperdrive 経由）。VPS 版・Lambda 版は旧構成（移行元）として残す。docs/cloudflare.md。
- Workers で動くコードでは、ファイルを読まない・AWS SDK を使わない（SES・SQS は providers/aws-http.ts）。メモリは 128MB なので、大きなデータは分けて扱う。
- 導入期はメール（SES）のみ。LINE は将来。送信は `MailProvider` 越しにだけ行い、プロバイダ固有コードを他に漏らさない。
- 決済は `PaymentProvider` 越しにだけ扱う（まず Stripe）。カード情報は扱わない。通知は一意制約（payment_events、orders）で二重に処理しない。docs/commerce.md。
- 読者データの正本は PostgreSQL。標準SQLの範囲で書き、特定クラウド固有DBに依存しない。
- 二重送信の防止は DB の一意制約（messages.idempotency_key）で担保する。アプリ側のチェックだけに頼らない。
- 配信停止・苦情・ハードバウンスは、スコアや区分より常に優先する。

## コード
- TypeScript strict。ドメインロジックは packages/core に純粋関数で置き、vitest でテストする。
- `pnpm test` と `pnpm typecheck` が通る状態でコミットする。Workers の形にまとめられるかは `pnpm cf:check`。
- 管理画面で使うアイコンを増やしたり、htmx・lucide-static の版を上げたりしたら `pnpm --dir packages/server gen:assets`（Workers に載せるため、コードとして書き出している）。
- GPL/AGPL の OSS（Mautic、listmonk、BillionMail 等）からコードを複製しない。設計の参考に留める。

## デザイン
- 見た目はデザインシステム「tsuzuri」（https://claude.ai/artifact/8KFvHUy6jBMogP1Mvzh1dQ）に従う。色・余白・角丸は `packages/server/src/ui/theme.ts` のトークンだけを使い、値を直書きしない。トークンを変えるときはデザインシステム側もそろえる。
- 読者向けページは外部のフォント・スクリプトを読み込まない。

## 個人情報
- メールアドレス等の個人情報・秘密値をコード、テスト、ログ、コミットに書かない。設定は .env（未コミット）で渡す。
- ログに出すのは contact id まで。

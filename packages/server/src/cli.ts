#!/usr/bin/env node
/**
 * 管理用コマンド。リポジトリ直下で `pnpm tsuzuri <command>` として使う。
 * .env があれば読み込む。DATABASE_URL が無ければ、ローカル用の PGlite（.data/）を使う。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { MemoryProvider, renderEmail, type MailProvider } from "@tsuzuri/core";
import { loadSettings, missingLegalFields, settingsFromEnv, type AppContext } from "./context.js";
import { pgDb, type Db } from "./db.js";
import { migrate } from "./migrate.js";
import { createApp } from "./http/app.js";
import { ConsoleProvider } from "./providers/ses.js";
import { launchDueBroadcasts } from "./services/broadcasts.js";
import { syncContent } from "./services/content.js";
import { importContacts } from "./services/import.js";
import { recomputeAllScores } from "./services/scoring.js";
import { sendMessage } from "./services/sending.js";
import { scheduleDueSteps } from "./services/sequences.js";
import { staleQueuedMessages } from "./services/tracking.js";
import { runAutomations } from "./services/automations.js";
import { listCustomVariables, setCustomVariable } from "./services/variables.js";

// 手元では .env、VPS の systemd 版では /etc/tsuzuri/tsuzuri.env を読む（Docker 版は compose.yml が TSUZURI_ENV_FILE を指定）
const envFile = process.env.TSUZURI_ENV_FILE ?? (existsSync(".env") ? ".env" : "/etc/tsuzuri/tsuzuri.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function openDb(): Promise<{ db: Db; exec?: (sql: string) => Promise<void>; close: () => Promise<void> }> {
  if (process.env.DATABASE_URL) {
    // Supabase など独自の CA を使う DB は、CA ファイルの場所を DATABASE_CA_FILE で渡す
    const caFile = process.env.DATABASE_CA_FILE;
    const ca = caFile ? await readFile(caFile, "utf8") : undefined;
    const db = pgDb(process.env.DATABASE_URL, {
      ...(ca ? { ca } : {}),
      ...(process.env.DATABASE_CA_SHA256 ? { caSha256: process.env.DATABASE_CA_SHA256 } : {}),
    });
    return { db, close: () => db.end() };
  }
  // ローカル試用：PGlite（開発用の依存）
  const { PGlite } = await import("@electric-sql/pglite");
  await mkdir(".data", { recursive: true });
  const pg = new PGlite(".data/pglite");
  const wrap = (q: { query: InstanceType<typeof PGlite>["query"] }): Db => ({
    async query(sql, params) {
      return (await q.query(sql, params as unknown[])).rows as never[];
    },
    transaction: (fn) => fn(wrap(q)),
  });
  const db: Db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx as never))) };
  return { db, exec: async (sql) => void (await pg.exec(sql)), close: () => pg.close() };
}

async function context(db: Db, provider: MailProvider): Promise<AppContext> {
  const secret = process.env.TOKEN_SECRET ?? process.env.UNSUBSCRIBE_SECRET ?? "local-development-secret-not-for-production";
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const totpSecret = process.env.ADMIN_TOTP_SECRET;
  return {
    ...(passwordHash && totpSecret ? { admin: { passwordHash, totpSecret } } : {}),
    db,
    provider,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    ...(process.env.LINK_BASE_URL ? { linkBaseUrl: process.env.LINK_BASE_URL.replace(/\/$/, "") } : {}),
    secret,
    settings: await loadSettings(db, { ...settingsFromEnv(), defaultName: "読者" }),
    now: () => new Date(),
  };
}

const HELP = `使い方: pnpm tsuzuri <command>

  migrate                          DB を最新の構造にする
  sync [dir]                       content/（既定）のシナリオ・フォーム・置き換え文字を DB に反映
  import <file.csv> --label <名前> --evidence <同意の取得方法>
                                   既存の読者リストを取り込む（列: email, name, consented_at, attr.*）
  settings <file.json>             送信者表示などの設定を保存（中身は docs/content.md）
  var:set <key> <value> [--url]    独自の置き換え文字を登録（例: var:set lp_url https://... --url）
  var:list                         独自の置き換え文字の一覧
  preview <sequence> <position>    ステップをサンプル値で HTML にして preview.html に書き出す
  form:embed <slug> [--no-name]    他のページに貼るフォームタグを出力する
  admin:setup --local [--env-file <path>] | --ssm
                                   管理画面のパスワードと認証アプリを設定する（.env など、または AWS の SSM に保存）
  backup:key                       バックアップの暗号化キー（TZK1-…）を新しく作って表示する（DB には触らない）
  backup:restore <file.tzb> --yes  R2 のバックアップ（管理画面の「バックアップ」でダウンロード）を DB に読み込む（今のデータをすべて置き換える）。
                                   キーは環境変数 BACKUP_ENCRYPTION_KEY で渡す（コマンドの引数に書かない）
  score                            読者スコアを再計算
  doctor [--http]                  本番前の自己点検（法定表示、フォーム、SES の状態など）。--http で公開ページも確認
  dev [--port 8787]                ローカルでフォーム・配信停止などを動かす（メールは送らず画面に表示）
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      label: { type: "string" },
      evidence: { type: "string" },
      url: { type: "boolean" },
      port: { type: "string" },
      "no-name": { type: "boolean" },
      local: { type: "boolean" },
      ssm: { type: "boolean" },
      "env-file": { type: "string" },
      http: { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  if (!cmd || cmd === "help") return void console.log(HELP);
  if (cmd === "admin:setup") {
    if (!values.local === !values.ssm) throw new Error("admin:setup --local（手元の .env）か --ssm（AWS）のどちらかを指定してください");
    const { adminSetup } = await import("./admin/setup.js");
    return adminSetup(values.ssm ? "ssm" : "local", "/tsuzuri/", values["env-file"] ?? ".env");
  }

  if (cmd === "backup:key") {
    const { generateTransferKey } = await import("@tsuzuri/core");
    console.log(generateTransferKey().text);
    console.error("\nこのキーはパスワード管理アプリなどに保管し、Worker には `wrangler secret put BACKUP_ENCRYPTION_KEY` で入れてください。\nキーを失うとバックアップは復元できません。");
    return;
  }

  const { db, exec, close } = await openDb();
  try {
    if (cmd === "migrate") {
      const done = await migrate(db, undefined, exec);
      console.log(done.length ? `適用: ${done.join(", ")}` : "最新です");
    } else if (cmd === "sync") {
      await migrate(db, undefined, exec);
      const r = await syncContent(db, resolve(positionals[0] ?? "content"));
      console.log(`置き換え文字 ${r.variables} / シナリオ ${r.sequences.length}（${r.steps} ステップ） / フォーム ${r.forms.length}`);
      for (const p of r.problems) console.log(`  ⚠ ${p}`);
      if (r.problems.length) process.exitCode = 1;
    } else if (cmd === "import") {
      const file = positionals[0];
      if (!file || !values.label || !values.evidence) throw new Error("import <file.csv> --label <名前> --evidence <同意の取得方法>");
      const r = await importContacts(db, await readFile(file, "utf8"), { label: values.label, evidence: values.evidence });
      console.log(`取り込み ${r.imported} / 既存のためスキップ ${r.skippedExisting} / 不正 ${r.invalid.length}`);
      for (const i of r.invalid) console.log(`  ${i.line} 行目: ${i.reason}`);
    } else if (cmd === "settings") {
      const file = positionals[0];
      if (!file) throw new Error("settings <file.json>");
      const json = JSON.parse(await readFile(file, "utf8"));
      await db.query(
        "INSERT INTO app_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()",
        [JSON.stringify(json)],
      );
      console.log("保存しました");
      const missing = missingLegalFields(await loadSettings(db, settingsFromEnv()));
      if (missing.length > 0) {
        console.log(`  ⚠ 未設定のため、メールは送信されません：${missing.join("、")}`);
        process.exitCode = 1;
      }
    } else if (cmd === "var:set") {
      const [key, value] = positionals;
      if (!key || value === undefined) throw new Error("var:set <key> <value> [--url]");
      const problem = await setCustomVariable(db, key, value, values.url ? "url" : "text");
      console.log(problem ?? `%${key}% を登録しました`);
    } else if (cmd === "var:list") {
      for (const v of await listCustomVariables(db)) console.log(`%${v.key}%\t${v.kind}\t${v.value}`);
    } else if (cmd === "preview") {
      const [slug, pos] = positionals;
      const [step] = await db.query<{ subject: string | null; body_markdown: string; body_format: "markdown" | "html" }>(
        `SELECT st.subject, st.body_markdown, st.body_format FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id
          WHERE s.slug = $1 AND st.position = $2`,
        [slug, Number(pos)],
      );
      if (!step) throw new Error("ステップが見つかりません");
      const ctx = await context(db, new MemoryProvider());
      const s = ctx.settings;
      const r = renderEmail({
        subject: step.subject ?? "",
        body: step.body_markdown,
        format: step.body_format,
        context: {
          builtins: {
            name: "山田", email: "reader@example.com", date: "2026年1月1日", sender: s.senderName, contact: s.contact,
            cancel: "https://example.com/u/sample", settings: "https://example.com/p/sample",
            download: "https://example.com/d/sample", webview: "https://example.com/w/sample", subscribed_date: "2026年1月1日",
          },
          custom: await listCustomVariables(db),
          attributes: {},
        },
        footer: {
          senderName: s.senderName || "（送信者名未設定）",
          senderInfoUrl: s.senderInfoUrl || "https://example.com/legal",
          contact: s.contact || "（問い合わせ先未設定）",
        },
        unsubscribeUrl: "https://example.com/u/sample",
      });
      await writeFile("preview.html", r.html);
      console.log(`件名: ${r.subject}\npreview.html に書き出しました`);
    } else if (cmd === "form:embed") {
      const [slug] = positionals;
      const [form] = await db.query<{ slug: string; button_label: string; allowed_origins: string[]; fields: unknown }>(
        "SELECT slug, button_label, allowed_origins, fields FROM forms WHERE slug = $1",
        [slug],
      );
      if (!form) throw new Error("フォームが見つかりません（先に sync してください）");
      const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
      const { embedSnippet } = await import("./http/pages.js");
      const { normalizeFields } = await import("@tsuzuri/core");
      console.log(embedSnippet({ action: `${base}/f/${form.slug}`, buttonLabel: form.button_label, withName: !values["no-name"], fields: normalizeFields(form.fields) }));
      if (form.allowed_origins.length === 0) {
        console.error("\n※ allowed_origins が未設定です。貼るサイトの https://ドメイン をフォームの設定に書くと、他のサイトからの悪用を防げます。");
      }
    } else if (cmd === "doctor") {
      const ctx = await context(db, new MemoryProvider());
      const { runDoctor, formatDoctor } = await import("./services/doctor.js");
      // AWS の認証情報がある場合だけ SES を確認する（手元の SSO なら AWS_PROFILE、VPS ならアクセスキー）
      const hasAws = Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID);
      const ses = hasAws ? new (await import("@aws-sdk/client-sesv2")).SESv2Client({ region: process.env.AWS_REGION ?? "ap-northeast-1" }) : undefined;
      const results = await runDoctor(ctx, {
        ...(ses ? { ses } : {}),
        ...(process.env.SES_CONFIGURATION_SET ? { configurationSet: process.env.SES_CONFIGURATION_SET } : {}),
        checkHttp: Boolean(values.http),
      });
      console.log(formatDoctor(results));
      if (results.some((r) => r.status === "fail")) process.exitCode = 1;
    } else if (cmd === "backup:restore") {
      const file = positionals[0];
      const keyText = process.env.BACKUP_ENCRYPTION_KEY;
      if (!file) throw new Error("backup:restore <file.tzx> --yes");
      if (!keyText) throw new Error("環境変数 BACKUP_ENCRYPTION_KEY にバックアップの暗号化キーを入れてください");
      await migrate(db, undefined, exec);
      const ctx = await context(db, new MemoryProvider());
      const { openTransfer, applyTransfer, checkPayload } = await import("./services/transfer.js");
      const { readBundle, BUNDLE_MAGIC } = await import("./services/cloud-backup.js");
      const { parseTransferKey } = await import("@tsuzuri/core");
      const buf = await readFile(file);
      // .tzb：毎晩のバックアップ（管理画面の「バックアップ」でダウンロード）／ .tzx：データの引き継ぎファイル
      const opened =
        buf.subarray(0, 4).toString("latin1") === BUNDLE_MAGIC
          ? await checkPayload(ctx, readBundle(buf, parseTransferKey(keyText)))
          : await openTransfer(ctx, buf, keyText);
      const total = Object.values(opened.counts).reduce((a, b) => a + b, 0);
      console.log(`バックアップの日時：${opened.payload.exportedAt}／${Object.keys(opened.counts).length} 個の表・${total} 行`);
      if (!opened.sameSecret) console.log("  ⚠ TOKEN_SECRET がバックアップを取った環境と違います。送ったメールの配信停止リンクなどが使えなくなります。");
      if (!values.yes) {
        console.log("今のデータをすべて置き換えます。よければ --yes を付けてもう一度実行してください。");
        process.exitCode = 1;
      } else {
        const counts = await applyTransfer(ctx, opened.payload);
        console.log(`読み込みました：${Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join("、")}`);
      }
    } else if (cmd === "score") {
      const ctx = await context(db, new MemoryProvider());
      console.log(await recomputeAllScores(ctx));
    } else if (cmd === "dev") {
      await migrate(db, undefined, exec);
      const ctx = await context(db, new ConsoleProvider());
      const { serve } = await import("@hono/node-server");
      const send = async (ids: string[]) => {
        for (const id of ids) await sendMessage(ctx, id);
      };
      const app = createApp(async () => ctx, { enqueue: send });
      const port = Number(values.port ?? 8787);
      serve({ fetch: app.fetch, port });
      console.log(`http://localhost:${port}/f/<フォームのslug> で試せます（メールは送らずここに表示）`);
      console.log(ctx.admin ? `管理画面：http://localhost:${port}/admin` : "管理画面を使うには、先に pnpm tsuzuri admin:setup --local を実行してください");
      setInterval(async () => {
        try {
          await runAutomations(ctx);
          await send([...(await scheduleDueSteps(ctx)), ...(await launchDueBroadcasts(ctx)), ...(await staleQueuedMessages(ctx))]);
        } catch (e) {
          console.error(e);
        }
      }, 15_000);
      return; // サーバーを動かし続ける
    } else {
      console.log(HELP);
      process.exitCode = 1;
    }
  } finally {
    if (cmd !== "dev") await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

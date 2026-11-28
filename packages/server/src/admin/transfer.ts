import { TransferKeyError } from "@tsuzuri/core";
import type { Hono } from "hono";
import { refreshSettings, type AppContext } from "../context.js";
import { applyTransfer, createExport, HISTORY_TABLES, openTransfer, readExport, TransferError } from "../services/transfer.js";
import { audit } from "./auth.js";
import { back, flashFrom } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, h, jst, pageHeader } from "./ui.js";

/** 管理画面の「データの引き継ぎ」：暗号化した書き出しと、暗号化キーでの読み込み */

/** VPS の Caddy の既定の上限（deploy/vps/Caddyfile の request_body） */
const PROXY_LIMIT = 6 * 1024 * 1024;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

const TABLE_LABEL: Record<string, string> = {
  contacts: "読者",
  channels: "メールアドレス",
  consents: "同意の記録",
  tags: "タグ",
  contact_tags: "読者のタグ",
  sequences: "シナリオ",
  sequence_steps: "ステップ",
  forms: "フォーム",
  enrollments: "シナリオの進み具合",
  broadcasts: "一斉配信",
  messages: "送信記録",
  events: "行動履歴（開封・クリックなど）",
  automation_rules: "自動化のルール",
  footers: "フッター",
  custom_variables: "置き換え文字",
  topics: "配信の種類",
  admin_passkeys: "パスキー",
};

function countsTable(counts: Record<string, number>): string {
  const main = Object.entries(counts).filter(([t]) => TABLE_LABEL[t]);
  const other = Object.entries(counts).filter(([t]) => !TABLE_LABEL[t]).reduce((a, [, n]) => a + n, 0);
  return `<div class="wrap"><table><tr><th>中身</th><th>件数</th></tr>${main
    .map(([t, n]) => `<tr><td>${h(TABLE_LABEL[t])}</td><td>${n.toLocaleString("ja-JP")}</td></tr>`)
    .join("")}<tr><td>その他（設定・集計など）</td><td>${other.toLocaleString("ja-JP")}</td></tr></table></div>`;
}

export function registerTransfer(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/transfer", async (c) => {
    const body = `${pageHeader({
      title: "データの引き継ぎ",
      desc: "別のサーバー・別のデータベースへ引っ越すときに使います。書き出したファイルは暗号化され、そのとき発行する暗号化キーがないと開けません。",
    })}
<style>.key-box{font:600 18px/1.6 var(--font-mono);letter-spacing:.02em;word-break:break-all;padding:var(--space-4);background:var(--surface-sunken);border:1px dashed var(--line-strong);border-radius:var(--radius-sm)}
.steps-list{margin:0;padding-left:1.2em;display:grid;gap:var(--space-1)}</style>
<section class="card"><h2 class="with-icon" style="margin-top:0">${icon("download", 16)}書き出す（引っ越し元で）</h2>
<p class="muted" style="margin:0 0 8px">読者・同意の記録・タグ・フォーム・シナリオ・一斉配信・設定などを 1 つのファイルにまとめ、暗号化します。書き出すたびに新しい暗号化キーを発行します（キーはこの画面に 1 回だけ表示し、サーバーには残しません）。</p>
<form method="post" action="/admin/transfer/export">
<label class="check"><input type="checkbox" name="history" value="1" checked>送信記録と行動履歴（開封・クリック）も含める（スコアやレポートを引き継ぐ。ファイルが大きくなる）</label>
<div class="actions"><button type="submit">${icon("lock", 16)}暗号化して書き出す</button></div></form></section>

<section class="card"><h2 class="with-icon" style="margin-top:0">${icon("upload", 16)}読み込む（引っ越し先で）</h2>
<ol class="steps-list muted"><li>引っ越し先に tsuzuri-mail を入れ、管理画面にログインできる状態にする（版は引っ越し元と同じか新しいもの）。</li>
<li>配信停止リンクなど、送ったメールのリンクを使い続けるため、環境変数 <code>TOKEN_SECRET</code> を引っ越し元と同じ値にする。</li>
<li>ここでファイルと暗号化キーを入れて読み込む。</li></ol>
<form method="post" action="/admin/transfer/import" enctype="multipart/form-data">
<label>引き継ぎファイル（.tzx）</label><input type="file" name="file" accept=".tzx,application/octet-stream" required>
<label>暗号化キー（TZK1- で始まる文字列）</label><input type="text" name="key" required autocomplete="off" spellcheck="false" placeholder="TZK1-XXXXXX-XXXXXX-…">
<label class="check"><input type="checkbox" name="confirm" value="1" required>この環境の今のデータ（読者・シナリオ・設定など）はすべて消え、ファイルの中身に置き換わることを確認しました</label>
<div class="actions"><button type="submit" class="danger">${icon("upload", 16)}読み込んで置き換える</button></div></form>
<p class="muted" style="margin:8px 0 0">途中で失敗した場合は何も変わりません。環境変数にある値（管理者のパスワード・認証アプリ、AWS の鍵、DB の接続先）はファイルに入らないので、引っ越し先で設定してください。</p></section>`;
    return c.html(adminPage({ title: "データの引き継ぎ", active: "/admin/transfer", body, flash: flashFrom(c) }));
  });

  app.post("/transfer/export", async (c) => {
    const ctx = await getCtx();
    const form = await c.req.parseBody();
    const includeHistory = form.history === "1";
    const r = await createExport(ctx, { includeHistory });
    await audit(ctx.db, "transfer.export", r.id, { includeHistory, bytes: r.bytes });
    const big = r.bytes > PROXY_LIMIT;
    const body = `${pageHeader({ title: "書き出しました", back: ["/admin/transfer", "データの引き継ぎ"] })}
<style>.key-box{font:600 17px/1.6 var(--font-mono);word-break:break-all;padding:var(--space-4);background:var(--surface-sunken);border:1px dashed var(--line-strong);border-radius:var(--radius-sm)}</style>
<section class="card"><h2 class="with-icon" style="margin-top:0">${icon("key-round", 16)}暗号化キー</h2>
<p style="margin:0 0 8px"><b>このキーは今だけ表示します。</b>パスワード管理アプリなど安全な場所に控えてください。キーがないとファイルは開けず、サーバーにも残っていないので再発行もできません。ファイルとキーは別々の場所に保管してください。</p>
<div class="key-box" id="tk">${h(r.keyText)}</div>
<div class="actions"><button type="button" class="sub" id="copy-key">${icon("copy", 16)}キーをコピー</button>
<a class="btn" href="/admin/transfer/exports/${h(r.id)}">${icon("download", 16)}ファイルをダウンロード（${mb(r.bytes)}）</a></div>
<p class="muted" style="margin:8px 0 0">ダウンロードできるのは 1 時間です（何度でも）。過ぎたら、もう一度書き出してください（そのときは新しいキーになります）。</p>
${big ? `<p class="flash error" style="margin-top:12px">${icon("triangle-exclamation-point", 16)}ファイルが ${mb(PROXY_LIMIT)} を超えています。VPS の標準の Caddy 設定（request_body の max_size 6MB）のままだと、引っ越し先で読み込めません。引っ越し先の Caddyfile の上限を一時的に上げるか、「送信記録と行動履歴」を外して書き出してください。</p>` : ""}</section>
<section class="card"><h2 style="margin-top:0">入っているもの</h2>${countsTable(r.counts)}</section>
<script>document.getElementById('copy-key').addEventListener('click',function(){var t=document.getElementById('tk').textContent;var b=this;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.lastChild.textContent='コピーしました'}).catch(function(){var r=document.createRange();r.selectNodeContents(document.getElementById('tk'));var s=getSelection();s.removeAllRanges();s.addRange(r)})});</script>`;
    c.header("Cache-Control", "no-store");
    return c.html(adminPage({ title: "データの引き継ぎ", active: "/admin/transfer", body }));
  });

  app.get("/transfer/exports/:id", async (c) => {
    const ctx = await getCtx();
    const r = await readExport(ctx, c.req.param("id"));
    if (!r) return back(c, "/admin/transfer", "err", "ダウンロードの期限が切れました。もう一度書き出してください");
    const day = jst(r.created_at).replace(/[^0-9]/g, "").slice(0, 12);
    return new Response(new Uint8Array(r.file), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="tsuzuri-transfer-${day}.tzx"`,
        "Cache-Control": "no-store",
      },
    });
  });

  app.post("/transfer/import", async (c) => {
    const ctx = await getCtx();
    const form = await c.req.parseBody();
    if (form.confirm !== "1") return back(c, "/admin/transfer", "err", "置き換えの確認にチェックを入れてください");
    const file = form.file;
    if (!(file instanceof File) || file.size === 0) return back(c, "/admin/transfer", "err", "引き継ぎファイルを選んでください");
    const key = typeof form.key === "string" ? form.key : "";
    let opened;
    try {
      opened = await openTransfer(ctx, Buffer.from(await file.arrayBuffer()), key);
    } catch (e) {
      if (e instanceof TransferKeyError || e instanceof TransferError) return back(c, "/admin/transfer", "err", e.message);
      throw e;
    }
    const imported = await applyTransfer(ctx, opened.payload);
    await refreshSettings(ctx);
    await audit(ctx.db, "transfer.import", undefined, { exportedAt: opened.payload.exportedAt, sameSecret: opened.sameSecret });
    const noHistory = HISTORY_TABLES.every((t) => !(t in opened.payload.tables));
    const body = `${pageHeader({ title: "読み込みました", back: ["/admin", "ホームへ"] })}
<section class="card"><p style="margin:0">${icon("circle-check", 16)} ${h(jst(new Date(opened.payload.exportedAt)))} に書き出したデータに置き換えました。このまま使えます。</p>
${
  opened.sameSecret
    ? ""
    : `<p class="flash error" style="margin-top:12px">${icon("triangle-exclamation-point", 16)}この環境の TOKEN_SECRET が引っ越し元と違います。データは読み込めていますが、これまでに送ったメールの配信停止リンク・配信設定リンク・確認リンク・計測リンクは使えません。引っ越し元と同じ値にして、tsuzuri-mail を再起動してください。</p>`
}
${noHistory ? '<p class="muted" style="margin:8px 0 0">送信記録と行動履歴は含まれていなかったため、スコアとレポートは引っ越し後のデータから数え直されます。</p>' : ""}
<div class="actions"><a class="btn" href="/admin/settings">${icon("settings", 16)}設定を確認する</a><a class="btn sub" href="/admin/readers">読者を見る</a></div></section>
<section class="card"><h2 style="margin-top:0">読み込んだもの</h2>${countsTable(imported)}</section>`;
    return c.html(adminPage({ title: "データの引き継ぎ", active: "/admin/transfer", body }));
  });
}

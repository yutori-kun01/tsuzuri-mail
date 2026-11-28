import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { backupDay, backupToR2, bundleStream, listBackups } from "../services/cloud-backup.js";
import { audit } from "./auth.js";
import { back, flashFrom } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, kpiCard, pageHeader } from "./ui.js";

/** R2 の無料枠（Standard ストレージ、月あたり）。2026-11 時点の Cloudflare の料金表 */
const R2_FREE_BYTES = 10 * 1024 ** 3;

const size = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** 管理画面の「バックアップ」：毎晩 R2 に置いたバックアップの一覧・容量・ダウンロード */
export function registerBackups(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/backups", async (c) => {
    const ctx = await getCtx();
    if (!ctx.backups) {
      const body = `${pageHeader({ title: "バックアップ", desc: "毎晩 3 時に、データベースの中身を暗号化して Cloudflare R2 に置きます。" })}
${emptyState({ icon: "database-backup", title: "バックアップの置き場所が設定されていません", text: "Cloudflare 版では wrangler.jsonc の r2_buckets に BACKUPS を入れます（docs/cloudflare.md）。VPS 版は BACKUP_DIR を使います。" })}`;
      return c.html(adminPage({ title: "バックアップ", active: "/admin/backups", body, flash: flashFrom(c) }));
    }
    const days = await listBackups(ctx.backups.bucket);
    const total = days.reduce((n, d) => n + d.bytes, 0);
    const latest = days.find((d) => d.complete);
    // 1 日分 × 保存日数で、いっぱいになったときの量を見積もる
    const estimate = (latest?.bytes ?? 0) * ctx.backups.keepDays;
    const rows = days
      .map(
        (d) => `<tr><td>${h(d.day)}</td><td>${size(d.bytes)}</td><td>${d.files}</td><td>${d.complete ? '<span class="pill good">完了</span>' : '<span class="pill warn">途中</span>'}</td>
<td>${d.complete ? `<a class="btn sub" href="/admin/backups/${h(d.day)}.tzb">${icon("download", 14)}ダウンロード</a>` : ""}</td></tr>`,
      )
      .join("");
    const body = `${pageHeader({ title: "バックアップ", desc: "毎晩 3 時（日本時間）に、全部の表を暗号化して Cloudflare R2 に置きます。保存期間を過ぎた分は自動で消えます。" })}
${ctx.backups.key ? "" : `<p class="flash error">${icon("triangle-exclamation-point", 16)}暗号化キー（BACKUP_ENCRYPTION_KEY）が未設定のため、バックアップを取っていません。<code>pnpm tsuzuri backup:key</code> で作り、<code>wrangler secret put BACKUP_ENCRYPTION_KEY</code> で入れてください。</p>`}
<div class="kpis">
${kpiCard({ label: "保存している量", value: size(total), hint: `${days.length} 日分`, icon: "database-backup" })}
${kpiCard({ label: "最新の 1 日分", value: latest ? size(latest.bytes) : "—", hint: latest ? latest.day : "まだありません", icon: "calendar" })}
${kpiCard({
  label: `${ctx.backups.keepDays} 日分たまったときの見込み`,
  value: latest ? size(estimate) : "—",
  hint: `R2 の無料枠 ${size(R2_FREE_BYTES)} の ${latest ? ((estimate / R2_FREE_BYTES) * 100).toFixed(1) : "—"}%`,
  icon: "hard-drive-download",
  ...(estimate > R2_FREE_BYTES ? { tone: "warn" as const } : {}),
})}
</div>
<section class="card"><h2 style="margin-top:0">復元のしかた</h2>
<ol class="muted" style="margin:0;padding-left:1.2em;line-height:1.9">
<li>下の一覧から日付を選んでダウンロードする（暗号化したまま 1 つのファイル .tzb になります）</li>
<li>手元で、復元先の DB を <code>DATABASE_URL</code> に、暗号化キーを <code>BACKUP_ENCRYPTION_KEY</code> に入れて <code>pnpm tsuzuri backup:restore &lt;ファイル&gt; --yes</code></li>
<li>配信停止リンクなどを使い続けるため、TOKEN_SECRET は元と同じにしておく</li></ol></section>
${days.length ? `<div class="wrap"><table><tr><th>日付</th><th>大きさ</th><th>ファイル数</th><th>状態</th><th></th></tr>${rows}</table></div>` : emptyState({ icon: "database-backup", title: "まだバックアップがありません", text: "毎晩 3 時に取ります。下のボタンで今すぐ取ることもできます。" })}
${ctx.backups.key ? `<form method="post" action="/admin/backups/run" class="actions"><button type="submit" class="sub">${icon("database-backup", 16)}今すぐバックアップを取る</button></form>` : ""}`;
    return c.html(adminPage({ title: "バックアップ", active: "/admin/backups", body, flash: flashFrom(c) }));
  });

  app.get("/backups/:file", async (c) => {
    const ctx = await getCtx();
    const m = /^(\d{4}-\d{2}-\d{2})\.tzb$/.exec(c.req.param("file"));
    if (!ctx.backups || !m) return c.text("not found", 404);
    const stream = await bundleStream(ctx.backups.bucket, m[1]!);
    if (!stream) return c.text("not found", 404);
    await audit(ctx.db, "backup.download", m[1]);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="tsuzuri-backup-${m[1]}.tzb"`,
        "Cache-Control": "no-store",
      },
    });
  });

  app.post("/backups/run", async (c) => {
    const ctx = await getCtx();
    if (!ctx.backups?.key) return back(c, "/admin/backups", "err", "暗号化キーが未設定です");
    const r = await backupToR2(ctx, ctx.backups.bucket, ctx.backups.key, backupDay(ctx.now()));
    await audit(ctx.db, "backup.run", r.manifest, { bytes: r.bytes, rows: r.rows });
    return back(c, "/admin/backups", "ok", `バックアップを取りました（${size(r.bytes)}・${r.rows} 行）`);
  });
}

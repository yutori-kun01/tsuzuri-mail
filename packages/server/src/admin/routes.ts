import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, pageHeader, pct, tabs } from "./ui.js";

/**
 * 登録経路：フォームの URL に ?r=識別名 を付けて、どこから登録したかを数える。
 * 経路ごとの URL とフォームタグは、各フォームの「URL・タグ」からコピーする。
 */

export const ROUTE_CODE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface RouteRow {
  id: string;
  code: string;
  name: string;
}

export async function listRoutes(ctx: AppContext): Promise<RouteRow[]> {
  return ctx.db.query<RouteRow>("SELECT id, code, name FROM signup_routes ORDER BY created_at");
}

/** 期間（日数。0 は全期間）の開始時刻 */
export function periodStart(ctx: AppContext, days: number): Date {
  return days > 0 ? new Date(ctx.now().getTime() - days * 86_400_000) : new Date(0);
}

export const PERIODS: [number, string][] = [
  [30, "30 日"],
  [90, "90 日"],
  [0, "全期間"],
];

export function registerRoutes(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/routes", async (c) => {
    const ctx = await getCtx();
    const days = PERIODS.some(([d]) => d === Number(c.req.query("days"))) ? Number(c.req.query("days")) : 30;
    const since = periodStart(ctx, days);
    const rows = await ctx.db.query<RouteRow & { signups: number; confirmed: number }>(
      `SELECT r.id, r.code, r.name,
              count(co.id)::int AS signups,
              count(co.id) FILTER (WHERE co.confirmed_at IS NOT NULL)::int AS confirmed
         FROM signup_routes r LEFT JOIN consents co ON co.route_id = r.id AND co.consented_at >= $1
        GROUP BY r.id ORDER BY r.created_at`,
      [since],
    );
    const [none] = await ctx.db.query<{ signups: number; confirmed: number }>(
      `SELECT count(*)::int AS signups, count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed
         FROM consents WHERE method = 'form' AND route_id IS NULL AND consented_at >= $1`,
      [since],
    );
    const byForm = await ctx.db.query<{ form: string; route: string | null; signups: number; confirmed: number }>(
      `SELECT f.name AS form, r.name AS route, count(*)::int AS signups, count(*) FILTER (WHERE co.confirmed_at IS NOT NULL)::int AS confirmed
         FROM consents co JOIN forms f ON f.id = co.form_id LEFT JOIN signup_routes r ON r.id = co.route_id
        WHERE co.method = 'form' AND co.consented_at >= $1
        GROUP BY f.name, r.name ORDER BY f.name, count(*) DESC`,
      [since],
    );
    const max = Math.max(1, ...rows.map((r) => r.signups), none?.signups ?? 0);
    const bar = (n: number) => `<div class="bar-track"><span style="width:${Math.round((n / max) * 100)}%"></span></div>`;
    const period = tabs(PERIODS.map(([d, l]) => ({ href: `/admin/routes?days=${d}`, label: l, current: d === days })));
    const table = rows.length
      ? `<div class="wrap"><table class="route-table"><tr><th>経路</th><th>識別名</th><th style="width:30%">登録</th><th>登録完了</th><th>完了率</th><th></th></tr>
${rows
  .map(
    (r) => `<tr><td><b>${h(r.name)}</b></td><td><code>?r=${h(r.code)}</code></td><td><div class="bar-cell"><span>${r.signups}</span>${bar(r.signups)}</div></td><td>${r.confirmed}</td><td>${pct(r.confirmed, r.signups)}</td>
<td><form method="post" action="/admin/routes/${h(r.id)}/delete" class="inline" onsubmit="return confirm('経路「${h(r.name)}」を削除しますか？（これまでの登録の記録は消えず、経路なしとして残ります）')"><button type="submit" class="sub icon-only" title="削除" aria-label="削除">${icon("trash", 14)}</button></form></td></tr>`,
  )
  .join("")}
<tr class="muted-row"><td>経路なし</td><td class="muted">URL に ?r= が無い登録</td><td><div class="bar-cell"><span>${none?.signups ?? 0}</span>${bar(none?.signups ?? 0)}</div></td><td>${none?.confirmed ?? 0}</td><td>${pct(none?.confirmed ?? 0, none?.signups ?? 0)}</td><td></td></tr></table></div>`
      : emptyState({ icon: "split", title: "まだ登録経路がありません", text: "下で「X プロフィール」「ブログのサイドバー」のように作り、フォームの URL に付けて貼ります。" });
    const formTable = byForm.length
      ? `<section class="card"><h2 style="margin-top:0">フォーム別</h2><div class="wrap"><table><tr><th>フォーム</th><th>経路</th><th>登録</th><th>登録完了</th><th>完了率</th></tr>${byForm
          .map((r) => `<tr><td>${h(r.form)}</td><td>${r.route ? h(r.route) : '<span class="muted">経路なし</span>'}</td><td>${r.signups}</td><td>${r.confirmed}</td><td>${pct(r.confirmed, r.signups)}</td></tr>`)
          .join("")}</table></div></section>`
      : "";
    const body = `${pageHeader({ title: "登録経路", desc: "X・Instagram・ブログなど、どこから登録したかを数えます。フォームの URL の末尾に ?r=識別名 を付けて貼ってください。" })}
<style>
.route-table td{vertical-align:middle}.route-table code{font-family:var(--font-mono);font-size:12px}
.bar-cell{display:flex;align-items:center;gap:var(--space-2)}.bar-cell span{min-width:32px;font-variant-numeric:tabular-nums}.bar-cell .bar-track{flex:1}
.muted-row td{color:var(--ink-muted)}
</style>
${period}
${table}
${formTable}
<details class="card add-step"${rows.length ? "" : " open"} id="new-route"><summary>${icon("plus", 16)}経路を追加</summary>
<form method="post" action="/admin/routes" class="row" style="align-items:flex-end">
<div><label>名前（例：X プロフィール）</label><input type="text" name="name" required maxlength="40"></div>
<div><label>識別名（URL の ?r= に付ける。英小文字・数字・ハイフン）</label><input type="text" name="code" required pattern="[a-z0-9][a-z0-9-]{0,31}" placeholder="x-profile"></div>
<div style="flex:0"><button type="submit">${icon("plus", 16)}追加</button></div></form>
<p class="muted">作ったら、各フォームの「URL・タグ」に経路ごとの URL とフォームタグが出るので、それを貼ってください。</p></details>`;
    return c.html(adminPage({ title: "登録経路", active: "/admin/routes", body, flash: flashFrom(c) }));
  });

  app.post("/routes", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const code = one(f, "code").trim().toLowerCase();
    const name = one(f, "name").trim().slice(0, 40);
    if (!name) return back(c, "/admin/routes", "err", "経路の名前を入れてください");
    if (!ROUTE_CODE.test(code)) return back(c, "/admin/routes", "err", "識別名は英小文字・数字・ハイフンで 1〜32 文字にしてください");
    const rows = await ctx.db.query("INSERT INTO signup_routes (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id", [code, name]);
    if (rows.length === 0) return back(c, "/admin/routes", "err", "同じ識別名の経路があります");
    await audit(ctx.db, "route.create", code);
    return back(c, "/admin/routes", "ok", `経路「${name}」を作りました。フォームの URL に ?r=${code} を付けて使います`);
  });

  app.post("/routes/:id/delete", async (c) => {
    const ctx = await getCtx();
    await ctx.db.query("DELETE FROM signup_routes WHERE id::text = $1", [c.req.param("id")]);
    await audit(ctx.db, "route.delete", c.req.param("id"));
    return back(c, "/admin/routes", "ok", "経路を削除しました（これまでの登録は経路なしとして残ります）");
  });
}

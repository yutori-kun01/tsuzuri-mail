import { DEFAULT_SES_PRICE_PER_1000_USD, estimateMonthlySes, projectMonth, sesCostUsd } from "@tsuzuri/core";
import type { Hono } from "hono";
import { refreshSettings, type AppContext } from "../context.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, h, pageHeader } from "./ui.js";

/**
 * Amazon SES の料金の目安。実際に送った通数（月ごと）と、読者数・配信回数からの見込みを出す。
 * 単価と為替は画面で入れる（料金は変わるので、公式の料金ページで確かめてもらう）。
 */

const PRICING_URL = "https://aws.amazon.com/ses/pricing/";

const num = (v: string | undefined, fallback: number, max = 1e9) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
};

export function registerCosts(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/costs", async (c) => {
    const ctx = await getCtx();
    const price = ctx.settings.sesPricePer1000Usd ?? DEFAULT_SES_PRICE_PER_1000_USD;
    const rate = ctx.settings.usdJpy;
    const money = (usd: number) => {
      const d = usd < 1 ? usd.toFixed(3) : usd.toFixed(2);
      return `$${d}${rate ? `<span class="muted">（約 ${Math.round(usd * rate).toLocaleString("ja-JP")} 円）</span>` : ""}`;
    };

    // 月ごとの実績（日本時間、直近 12 か月）
    const now = ctx.now();
    const jstNow = new Date(now.getTime() + 9 * 3_600_000);
    const y = jstNow.getUTCFullYear();
    const mo = jstNow.getUTCMonth();
    const start = new Date(Date.UTC(y, mo - 11, 1) - 9 * 3_600_000);
    const rows = await ctx.db.query<{ m: string; broadcast: number; sequence: number; optin: number }>(
      `SELECT to_char(sent_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS m,
              count(*) FILTER (WHERE kind = 'broadcast')::int AS broadcast,
              count(*) FILTER (WHERE kind = 'sequence')::int AS sequence,
              count(*) FILTER (WHERE kind = 'optin')::int AS optin
         FROM messages WHERE sent_at >= $1 GROUP BY 1`,
      [start],
    );
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(y, mo - 11 + i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const r = rows.find((x) => x.m === key);
      return { key, broadcast: r?.broadcast ?? 0, sequence: r?.sequence ?? 0, optin: r?.optin ?? 0 };
    }).reverse();
    const cur = months[0]!;
    const curTotal = cur.broadcast + cur.sequence + cur.optin;
    const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const projected = projectMonth(curTotal, jstNow.getUTCDate(), daysInMonth);
    const max = Math.max(1, ...months.map((m) => m.broadcast + m.sequence + m.optin));

    // 見込みの初期値（今のデータから）
    const [d] = await ctx.db.query<{ readers: number; broadcasts90: number; signups30: number; steps: number | null; double: boolean }>(
      `SELECT (SELECT count(*) FROM contacts WHERE status = 'active')::int AS readers,
              (SELECT count(*) FROM broadcasts WHERE status = 'sent' AND scheduled_at >= $1)::int AS broadcasts90,
              (SELECT count(*) FROM consents WHERE consented_at >= $2)::int AS signups30,
              (SELECT avg(n)::float FROM (SELECT count(st.id) AS n FROM sequences s JOIN sequence_steps st ON st.sequence_id = s.id
                 WHERE s.status = 'active' AND s.purpose = 'normal' GROUP BY s.id) x) AS steps,
              EXISTS (SELECT 1 FROM forms WHERE active AND double_optin) AS double`,
      [new Date(now.getTime() - 90 * 86_400_000), new Date(now.getTime() - 30 * 86_400_000)],
    );
    const qv = (k: string) => c.req.query(k);
    const plan = {
      readers: Math.round(num(qv("readers"), d?.readers ?? 0)),
      broadcastsPerMonth: num(qv("broadcasts"), Math.round(((d?.broadcasts90 ?? 0) / 3) * 10) / 10 || 4, 100),
      signupsPerMonth: Math.round(num(qv("signups"), d?.signups30 ?? 0)),
      stepsPerSignup: Math.round(num(qv("steps"), Math.round(d?.steps ?? 0), 365)),
      confirmationEmail: qv("readers") !== undefined ? qv("confirm") === "1" : !!d?.double,
    };
    const est = estimateMonthlySes(plan, price);
    const scale = [1000, 3000, 10_000, 30_000].map((r) => ({ r, e: estimateMonthlySes({ ...plan, readers: r }, price) }));

    const body = `${pageHeader({
      title: "SES の料金の目安",
      desc: "Amazon SES の送信料金を、実際に送った通数と、読者数・配信回数からの見込みで計算します。送信通数 × 単価だけの目安です。",
    })}
<style>.cost-kpi{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3);margin-bottom:var(--space-4)}
@media (max-width:760px){.cost-kpi{grid-template-columns:minmax(0,1fr)}}
.cost-kpi .stat b .muted{display:block;font-size:13px;font-weight:500}
.mbar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--surface-sunken);min-width:80px}
.mbar span{display:block;height:100%}
.legend-row{display:flex;gap:var(--space-4);flex-wrap:wrap;font-size:12px;color:var(--ink-muted);margin:0 0 var(--space-2)}
.legend-row i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.plan .row>div{min-width:150px}</style>
<div class="cost-kpi">
<div class="stat"><b>${money(sesCostUsd(curTotal, price))}</b><span>今月ここまで（${curTotal.toLocaleString("ja-JP")} 通）</span></div>
<div class="stat"><b>${money(sesCostUsd(projected, price))}</b><span>今月の見込み（日割りで約 ${projected.toLocaleString("ja-JP")} 通）</span></div>
<div class="stat"><b>${money(est.usd)}</b><span>下の条件での 1 か月（${est.total.toLocaleString("ja-JP")} 通）</span></div></div>

<section class="card plan"><h2 class="with-icon" style="margin-top:0">${icon("calculator", 16)}見込みを計算する</h2>
<p class="muted" style="margin:0 0 4px">初期値は今のデータから入れています（一斉配信の回数は直近 90 日の平均で、実績が無ければ週 1 回＝月 4 回。登録は直近 30 日、通数は配信中のシナリオの平均）。数字を変えて「計算する」を押してください。</p>
<form method="get" action="/admin/costs"><div class="row">
<div><label>配信中の読者</label><input type="number" name="readers" min="0" value="${h(plan.readers)}"></div>
<div><label>一斉配信（月あたりの回数）</label><input type="number" name="broadcasts" min="0" step="0.1" value="${h(plan.broadcastsPerMonth)}"></div>
<div><label>新しい登録（月あたり）</label><input type="number" name="signups" min="0" value="${h(plan.signupsPerMonth)}"></div>
<div><label>1 人に届くシナリオの通数</label><input type="number" name="steps" min="0" value="${h(plan.stepsPerSignup)}"></div></div>
<label class="check"><input type="checkbox" name="confirm" value="1"${plan.confirmationEmail ? " checked" : ""}>登録時に確認メールを送る（ダブルオプトイン）</label>
<div class="actions"><button type="submit" class="sub">計算する</button></div></form>
<div class="wrap" style="margin-top:var(--space-3)"><table><tr><th>内訳</th><th>通数</th><th>料金</th></tr>
<tr><td>一斉配信</td><td>${est.broadcastEmails.toLocaleString("ja-JP")}</td><td>${money(sesCostUsd(est.broadcastEmails, price))}</td></tr>
<tr><td>シナリオ</td><td>${est.sequenceEmails.toLocaleString("ja-JP")}</td><td>${money(sesCostUsd(est.sequenceEmails, price))}</td></tr>
<tr><td>確認メール</td><td>${est.confirmationEmails.toLocaleString("ja-JP")}</td><td>${money(sesCostUsd(est.confirmationEmails, price))}</td></tr>
<tr><td><b>合計（1 か月）</b></td><td><b>${est.total.toLocaleString("ja-JP")}</b></td><td><b>${money(est.usd)}</b></td></tr>
<tr><td>1 年あたり</td><td>${(est.total * 12).toLocaleString("ja-JP")}</td><td>${money(est.usd * 12)}</td></tr></table></div>
<h2>読者が増えたら（ほかの条件は同じ）</h2>
<div class="wrap"><table><tr><th>配信中の読者</th><th>月の通数</th><th>月の料金</th></tr>${scale
      .map((s) => `<tr><td>${s.r.toLocaleString("ja-JP")} 人</td><td>${s.e.total.toLocaleString("ja-JP")}</td><td>${money(s.e.usd)}</td></tr>`)
      .join("")}</table></div></section>

<section class="card"><h2 style="margin-top:0">月ごとの実績（直近 12 か月）</h2>
<p class="legend-row"><span><i style="background:var(--chart-1)"></i>一斉配信</span><span><i style="background:var(--chart-2)"></i>シナリオ</span><span><i style="background:var(--chart-3)"></i>確認メール</span></p>
<div class="wrap"><table><tr><th>月</th><th style="width:40%">通数</th><th>合計</th><th>料金</th></tr>${months
      .map((m) => {
        const t = m.broadcast + m.sequence + m.optin;
        const w = (n: number) => `${((n / max) * 100).toFixed(1)}%`;
        return `<tr><td>${m.key.replace("-", " 年 ")} 月</td><td><div class="mbar" title="一斉配信 ${m.broadcast}・シナリオ ${m.sequence}・確認メール ${m.optin}"><span style="width:${w(m.broadcast)};background:var(--chart-1)"></span><span style="width:${w(m.sequence)};background:var(--chart-2)"></span><span style="width:${w(m.optin)};background:var(--chart-3)"></span></div></td><td>${t.toLocaleString("ja-JP")}</td><td>${money(sesCostUsd(t, price))}</td></tr>`;
      })
      .join("")}</table></div>
<p class="muted" style="margin:8px 0 0">実際に SES へ渡した通数（テスト送信は含まない）。請求額は AWS の請求ダッシュボードで確認してください。</p></section>

<section class="card"><h2 style="margin-top:0">単価と為替</h2>
<form method="post" action="/admin/costs"><div class="row">
<div><label>送信 1,000 通あたりの料金（USD）</label><input type="number" name="price" min="0" max="100" step="0.0001" value="${h(price)}" required></div>
<div><label>為替（1 USD あたりの円。空なら円は出さない）</label><input type="number" name="usdJpy" min="0" max="10000" step="0.01" value="${h(rate ?? "")}"></div></div>
<div class="actions"><button type="submit">保存する</button></div></form>
<p class="muted" style="margin:8px 0 0">初期値の ${DEFAULT_SES_PRICE_PER_1000_USD} USD は、導入時に要件書へ記録した値です。料金は変わることがあるので、<a href="${PRICING_URL}" target="_blank" rel="noopener">Amazon SES の公式の料金ページ</a>で今の単価を確かめて入れてください。
この計算に入っていないもの：添付ファイルなどのデータ量による料金、専用 IP や追加の機能の料金、無料枠、税、SNS・SQS など SES 以外のサービスの料金。</p></section>`;
    return c.html(adminPage({ title: "SES の料金の目安", active: "/admin/costs", body, flash: flashFrom(c) }));
  });

  app.post("/costs", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const price = Number(one(f, "price"));
    if (!Number.isFinite(price) || price <= 0 || price > 100) return back(c, "/admin/costs", "err", "1,000 通あたりの料金を正しく入れてください");
    const rateRaw = one(f, "usdJpy");
    const rate = rateRaw === "" ? undefined : Number(rateRaw);
    if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0 || rate > 10_000)) return back(c, "/admin/costs", "err", "為替を正しく入れてください");
    const [cur] = await ctx.db.query<{ settings: Record<string, unknown> }>("SELECT settings FROM app_settings WHERE id = 1");
    const merged: Record<string, unknown> = { ...(cur?.settings ?? {}), sesPricePer1000Usd: price };
    if (rate === undefined) delete merged.usdJpy;
    else merged.usdJpy = rate;
    await ctx.db.query(
      "INSERT INTO app_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()",
      [JSON.stringify(merged)],
    );
    if (rate === undefined) delete ctx.settings.usdJpy;
    await refreshSettings(ctx);
    await audit(ctx.db, "settings.costs");
    return back(c, "/admin/costs", "ok", "保存しました");
  });
}

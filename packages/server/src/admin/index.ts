import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { missingLegalFields, refreshSettings, type AppContext, type AppSettings } from "../context.js";
import { defaultScoreSettings, validateCustomKey, type ScoreSettings } from "@tsuzuri/core";
import { unsubscribe } from "../services/subscription.js";
import { deleteCustomVariable, setCustomVariable } from "../services/variables.js";
import { loadScoreSettings } from "../services/scoring.js";
import { audit, endSession, login, requireAdmin, startSession } from "./auth.js";
import { registerBroadcasts } from "./broadcasts.js";
import { back, flashFrom, list, many, one, readForm, tagsFrom, tagsWithCounts } from "./common.js";
import { registerContent } from "./content.js";
import { registerAutomations } from "./automations.js";
import { registerFooters } from "./footers.js";
import { registerDomains } from "./domains.js";
import { registerRoutes } from "./routes.js";
import { registerGroups } from "./groups.js";
import { registerReaderAdd } from "./readers-add.js";
import { registerTopics } from "./topics.js";
import { registerTags } from "./tags.js";
import { registerPasskeyLogin, registerPasskeys } from "./passkeys.js";
import { registerTransfer } from "./transfer.js";
import { registerCosts } from "./costs.js";
import { logViewTabs, registerMailLogs } from "./logs.js";
import { htmxScriptPath, icon } from "./icons.js";
import { ADMIN_CSP, adminPage, avatar, delta, donut, emptyState, h, jst, kpiCard, legend, lineChart, linkButton, loginPage, pageHeader, pct, ring, statusPill, tabs, tagPicker, tierPill, TIERS } from "./ui.js";

export interface AdminOptions {
  /** 確認メールなど、すぐ送るべき送信記録をキューに積む */
  enqueue: (ids: string[]) => Promise<void>;
}

/** タグの id（無ければ作る） */
async function tagIdFor(ctx: AppContext, name: string): Promise<string> {
  const prefix = name.split(":")[0] ?? "";
  const category = ["src", "int", "seq", "cust", "ch"].includes(prefix) ? prefix : "cust";
  const [t] = await ctx.db.query<{ id: string }>(
    "INSERT INTO tags (name, category) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [name, category],
  );
  return t!.id;
}

export function createAdmin(getCtx: () => Promise<AppContext>, opts: AdminOptions): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", ADMIN_CSP);
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });

  // htmx（0BSD）を自分のサーバーから配る。外部 CDN は使わない
  let htmx: string | undefined;
  app.get("/assets/htmx.min.js", (c) => {
    htmx ??= readFileSync(htmxScriptPath(), "utf8");
    c.header("Cache-Control", "public, max-age=604800, immutable");
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(htmx);
  });

  // ---- ログイン ----
  app.get("/login", async (c) => {
    const ctx = await getCtx();
    if (!ctx.admin) return c.html(loginPage("管理画面のログイン情報が設定されていません（docs/admin.md）"), 503);
    const [pk] = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_passkeys");
    return c.html(loginPage(undefined, (pk?.n ?? 0) > 0));
  });

  app.post("/login", async (c) => {
    const ctx = await getCtx();
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return c.text("forbidden", 403);
    const f = await readForm(c);
    const r = await login(ctx, one(f, "password"), one(f, "code"));
    if (r === "ok") {
      startSession(c, ctx);
      return c.redirect("/admin", 303);
    }
    const msg =
      r === "locked"
        ? "ログインの失敗が続いたため、15 分間ログインできません。"
        : r === "disabled"
          ? "管理画面のログイン情報が設定されていません。"
          : "パスワードまたはコードが違います。";
    return c.html(loginPage(msg), r === "locked" ? 429 : 401);
  });

  app.post("/logout", (c) => {
    endSession(c);
    return c.redirect("/admin/login", 303);
  });

  // パスキーでのログイン（ログイン前に使う）
  registerPasskeyLogin(app, getCtx);

  app.use("*", requireAdmin(getCtx));
  // 設定は管理画面で変わりうるので、毎回読み直す
  app.use("*", async (_c, next) => {
    await refreshSettings(await getCtx());
    await next();
  });

  // ---- ホーム ----
  app.get("/", async (c) => {
    const ctx = await getCtx();
    // 期間（7・30・90 日）。差分は「直前の同じ長さの期間」と比べる
    const range = [7, 30, 90].includes(Number(c.req.query("range"))) ? Number(c.req.query("range")) : 30;
    const DAY = 86_400_000;
    const dayKey = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    const todayKey = dayKey(ctx.now());
    const start = new Date(new Date(`${todayKey}T00:00:00+09:00`).getTime() - (range - 1) * DAY);
    const prevStart = new Date(start.getTime() - range * DAY);
    const keys = Array.from({ length: range }, (_, k) => dayKey(new Date(start.getTime() + k * DAY + 3_600_000)));

    const byStatus = await ctx.db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM contacts GROUP BY status");
    const byTier = await ctx.db.query<{ tier: string; n: number }>(
      "SELECT tier, count(*)::int AS n FROM contacts WHERE status = 'active' GROUP BY tier",
    );
    const get = (rows: { n: number }[], key: string, field: "status" | "tier") =>
      (rows as ({ n: number } & Record<string, string | number>)[]).find((r) => r[field] === key)?.n ?? 0;
    const active = get(byStatus, "active", "status");

    const sentDaily = await ctx.db.query<{ d: string; n: number }>(
      `SELECT to_char(sent_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM messages WHERE sent_at >= $1 AND kind <> 'optin' GROUP BY 1`,
      [start],
    );
    const subDaily = await ctx.db.query<{ d: string; n: number }>(
      `SELECT to_char(occurred_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM events WHERE type IN ('subscribe','resubscribe') AND occurred_at >= $1 GROUP BY 1`,
      [start],
    );
    const series = (rows: { d: string; n: number }[]) => keys.map((k) => rows.find((r) => r.d === k)?.n ?? 0);
    const sentS = series(sentDaily);
    const subS = series(subDaily);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

    // 期間ごとの集計（今の期間と直前の期間）
    const periodStats = async (from: Date, to: Date) => {
      const [m] = await ctx.db.query<{ sent: number; bounced: number; complained: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS sent,
                count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
                count(*) FILTER (WHERE status = 'complained')::int AS complained,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM messages WHERE queued_at >= $1 AND queued_at < $2 AND kind <> 'optin'`,
        [from, to],
      );
      const [e] = await ctx.db.query<{ subs: number; unsubs: number }>(
        `SELECT count(*) FILTER (WHERE type IN ('subscribe','resubscribe'))::int AS subs,
                count(*) FILTER (WHERE type = 'unsubscribe')::int AS unsubs
           FROM events WHERE occurred_at >= $1 AND occurred_at < $2`,
        [from, to],
      );
      return { ...(m ?? { sent: 0, bounced: 0, complained: 0, failed: 0 }), ...(e ?? { subs: 0, unsubs: 0 }) };
    };
    const end = new Date(start.getTime() + range * DAY);
    const cur = await periodStats(start, end);
    const prev = await periodStats(prevStart, start);
    const rate = (n: number, dd: number) => (dd > 0 ? (n / dd) * 100 : null);
    const bounceRate = rate(cur.bounced, cur.sent);
    const prevBounceRate = rate(prev.bounced, prev.sent);
    // 配信中の読者の増減は「新規登録 − 配信停止」で近似する（期間の初めの人数は保存していないため）
    const netPrev = active - (cur.subs - cur.unsubs);

    const [stuck] = await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM messages WHERE status = 'queued' AND error IS NOT NULL",
    );
    const warn: string[] = [];
    if (cur.sent >= 50 && cur.bounced / cur.sent > 0.04) warn.push(`バウンス率が ${pct(cur.bounced, cur.sent)} です（5% を超えると SES の審査対象になりえます）`);
    if (cur.sent >= 50 && cur.complained / cur.sent > 0.001) warn.push(`苦情率が ${pct(cur.complained, cur.sent)} です（0.1% 未満が目安）`);
    if ((stuck?.n ?? 0) > 0) warn.push(`送信できずに待機中のメールが ${stuck!.n} 通あります`);
    if (cur.failed > 0) warn.push(`送信に失敗したメールが ${cur.failed} 通あります`);

    const recent = await ctx.db.query<{ id: string; subject: string | null; status: string; scheduled_at: Date | null; recipients: number; delivered: number; opened: number; clicked: number }>(
      `SELECT b.id, b.subject, b.status, b.scheduled_at,
              (SELECT count(*) FROM messages m WHERE m.broadcast_id = b.id)::int AS recipients,
              (SELECT count(*) FROM messages m WHERE m.broadcast_id = b.id AND m.status = 'delivered')::int AS delivered,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages m ON m.id = e.message_id
                WHERE m.broadcast_id = b.id AND e.type = 'open' AND NOT e.machine)::int AS opened,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages m ON m.id = e.message_id
                WHERE m.broadcast_id = b.id AND e.type = 'click' AND e.bot_reason IS NULL)::int AS clicked
         FROM broadcasts b ORDER BY coalesce(b.scheduled_at, b.created_at) DESC LIMIT 5`,
    );
    const [counts] = await ctx.db.query<{ forms: number; sequences: number; broadcasts: number; topics: number }>(
      `SELECT (SELECT count(*) FROM forms)::int AS forms, (SELECT count(*) FROM sequences)::int AS sequences,
              (SELECT count(*) FROM topics)::int AS topics,
              (SELECT count(*) FROM broadcasts WHERE status IN ('scheduled','sending','sent'))::int AS broadcasts`,
    );
    const steps: [boolean, string, string][] = [
      [missingLegalFields(ctx.settings).length === 0, "送信者情報の設定", "/admin/settings"],
      [(ctx.settings.testRecipients ?? []).length > 0, "テスト送信先の登録", "/admin/settings"],
      [(counts?.forms ?? 0) > 0, "フォームを作成", "/admin/forms"],
      [(counts?.sequences ?? 0) > 0, "シナリオを作成", "/admin/sequences"],
      [(counts?.broadcasts ?? 0) > 0, "最初の一斉配信を予約", "/admin/broadcasts/new"],
    ];
    const done = steps.filter((x) => x[0]).length;
    const setup =
      done === steps.length
        ? ""
        : `<section class="card setup">${ring(done, steps.length)}<div><h2>はじめの準備</h2><ul class="steps">${steps
            .map(
              ([ok, label, href]) =>
                `<li${ok ? ' class="done"' : ""}><span class="check-icon">${icon(ok ? "circle-check" : "circle", 18)}</span>${ok ? `<span class="label">${h(label)}</span>` : `<a class="label" href="${href}">${h(label)}</a>`}</li>`,
            )
            .join("")}</ul></div></section>`;

    const recentHtml = recent.length
      ? `<div class="wrap"><table><tr><th>件名</th><th>状態</th><th>配信日時</th><th>宛先</th><th>開封</th><th>クリック</th></tr>${recent
          .map(
            (r) => `<tr><td><span class="mail-cell">${icon("mail", 16)}<a href="/admin/broadcasts/${h(r.id)}">${h(r.subject || "（件名なし）")}</a></span></td><td>${statusPill(r.status)}</td>
<td>${h(jst(r.scheduled_at))}</td><td>${r.recipients.toLocaleString("ja-JP")}</td><td>${pct(r.opened, r.recipients)}</td><td>${pct(r.clicked, r.recipients)}</td></tr>`,
          )
          .join("")}</table></div>`
      : emptyState({ icon: "send", title: "まだ一斉配信がありません", text: "下書きを作り、プレビューとテスト送信で確かめてから予約できます。", action: linkButton("/admin/broadcasts/new", "一斉配信を作る", "plus") });

    const notice = warn.length
      ? `<section class="card notice"><h2>${icon("triangle-exclamation-point", 18)}注意</h2><ul>${warn.map((t) => `<li>${h(t)}</li>`).join("")}</ul>
<div class="actions"><a class="btn sub" href="/admin/logs">配信ログを確認${icon("arrow-right", 16)}</a></div></section>`
      : `<section class="card notice ok"><h2>${icon("shield-check", 18)}配信は健全です</h2><p class="muted" style="margin:0">バウンス率 ${pct(cur.bounced, cur.sent)}・苦情率 ${pct(cur.complained, cur.sent)}（過去 ${range} 日）。目安はバウンス 5% 未満・苦情 0.1% 未満です。</p></section>`;

    const tierColors: Record<string, string> = { hot: "--chart-1", normal: "--chart-2", low: "--chart-3", dormant: "--chart-4", evaluating: "--chart-5" };
    const rangeSelect = `<form method="get" class="range">${icon("calendar", 16)}<select name="range" aria-label="期間" onchange="this.form.submit()">${[7, 30, 90]
      .map((r) => `<option value="${r}"${r === range ? " selected" : ""}>過去 ${r} 日</option>`)
      .join("")}</select><noscript><button class="sub" type="submit">表示</button></noscript></form>`;

    const body = `${pageHeader({
      title: "ホーム",
      desc: "配信の状況と、これからの行動を確認できます。",
      actions: rangeSelect + linkButton("/admin/broadcasts/new", "一斉配信を作成", "plus"),
    })}
${setup}
<div class="kpis">
${kpiCard({ label: "配信中の読者", value: active.toLocaleString("ja-JP"), icon: "users", change: { pct: delta(active, netPrev) }, hint: `一時停止 ${get(byStatus, "paused", "status")}・配信停止 ${get(byStatus, "unsubscribed", "status")}` })}
${kpiCard({ label: `新規登録（${range} 日）`, value: cur.subs.toLocaleString("ja-JP"), icon: "user-plus", spark: subS, change: { pct: delta(cur.subs, prev.subs) } })}
${kpiCard({ label: `送信数（${range} 日）`, value: cur.sent.toLocaleString("ja-JP"), icon: "send", spark: sentS, change: { pct: delta(cur.sent, prev.sent) } })}
${kpiCard({
      label: `バウンス率（${range} 日）`,
      value: pct(cur.bounced, cur.sent),
      icon: "shield-check",
      ...(cur.sent >= 50 && cur.bounced / cur.sent > 0.04 ? { tone: "bad" as const } : {}),
      ...(bounceRate !== null && prevBounceRate !== null ? { change: { pct: null, abs: bounceRate - prevBounceRate, unit: "pt", upIsGood: false } } : {}),
      hint: `苦情率 ${pct(cur.complained, cur.sent)}`,
    })}
</div>
<div class="two wide">
<section class="card"><div class="card-head"><h2>配信と新規登録の推移（${range} 日）</h2>${legend(["送信数", "新規登録"])}</div>
${lineChart({ series: [sentS, subS], labels: keys.map((k) => `${Number(k.slice(5, 7))}/${Number(k.slice(8))}`), names: ["送信数", "新規登録"] })}</section>
<section class="card"><div class="card-head"><h2>読者の区分</h2><a href="/admin/readers?status=active">一覧へ</a></div>
${donut({ items: TIERS.map(([k, label]) => ({ label, value: get(byTier, k, "tier"), color: tierColors[k] ?? "--chart-5", href: `/admin/readers?tier=${k}&status=active` })), center: active.toLocaleString("ja-JP"), sub: "人" })}
<p class="muted" style="margin:16px 0 0">区分はスコアから毎晩自動で決まります。休眠の読者には一斉配信が届きません。</p></section>
</div>
<div class="two wide">
<section class="card"><div class="card-head"><h2>最近の一斉配信</h2><a href="/admin/broadcasts">すべて見る →</a></div>${recentHtml}</section>
${notice}
</div>`;
    return c.html(adminPage({ title: "ホーム", active: "/admin", body, flash: flashFrom(c) }));
  });

  // ---- パスキー・データの引き継ぎ・料金の目安 ----
  registerPasskeys(app, getCtx);
  registerTransfer(app, getCtx);
  registerCosts(app, getCtx);

  // ---- タグ ----
  registerTags(app, getCtx);

  // ---- 読者 ----
  // /readers/new を /readers/:id より先に登録する
  registerReaderAdd(app, getCtx, opts);

  app.get("/readers", async (c) => {
    const ctx = await getCtx();
    const q = (c.req.query("q") ?? "").trim();
    const tag = (c.req.query("tag") ?? "").trim();
    const tier = c.req.query("tier") ?? "";
    const status = c.req.query("status") ?? "";
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const params: unknown[] = [];
    const where: string[] = ["TRUE"];
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(ch.address LIKE $${params.length} OR lower(coalesce(c.display_name,'')) LIKE $${params.length})`);
    }
    if (tag) {
      params.push(tag);
      where.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.name = $${params.length})`);
    }
    if (tier) {
      params.push(tier);
      where.push(`c.tier = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`c.status = $${params.length}`);
    }
    params.push(50, (page - 1) * 50);
    const rows = await ctx.db.query<{
      id: string;
      address: string | null;
      display_name: string | null;
      status: string;
      tier: string;
      score: string;
      created_at: Date;
      tags: string[];
    }>(
      `SELECT c.id, ch.address, c.display_name, c.status, c.tier, c.score, c.created_at,
              COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id), '{}') AS tags
         FROM contacts c LEFT JOIN channels ch ON ch.contact_id = c.id AND ch.kind = 'email'
        WHERE ${where.join(" AND ")}
        ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const tags = await ctx.db.query<{ name: string }>("SELECT name FROM tags ORDER BY name");
    const opt = (v: string, label: string, cur: string) => `<option value="${h(v)}"${v === cur ? " selected" : ""}>${h(label)}</option>`;
    const qs = (p: number) =>
      `?${new URLSearchParams({ q, tag, tier, status, page: String(p) }).toString()}`;
    const filtered = Boolean(q || tag || tier || status);
    const body = `${pageHeader({
      title: "読者",
      desc: "タグ・区分・状態は選ぶとすぐ絞り込まれます。メールアドレスを押すと履歴とタグを確認できます。",
      actions: linkButton("/admin/readers/new?tab=csv", "CSV で取り込む", "upload", true) + linkButton("/admin/readers/new", "読者を追加", "user-plus"),
    })}
<form method="get" class="toolbar" role="search">
<div class="search">${icon("search", 16)}<input type="search" name="q" value="${h(q)}" placeholder="メールアドレス・名前で検索" aria-label="メールアドレス・名前で検索"></div>
<select name="tag" aria-label="タグ" onchange="this.form.submit()">${opt("", "タグ：すべて", tag)}${tags.map((t) => opt(t.name, t.name, tag)).join("")}</select>
<select name="tier" aria-label="区分" onchange="this.form.submit()">${opt("", "区分：すべて", tier)}${TIERS.map(([k, l]) => opt(k, l, tier)).join("")}</select>
<select name="status" aria-label="状態" onchange="this.form.submit()">${opt("", "状態：すべて", status)}${["pending", "active", "paused", "stopped", "unsubscribed"]
      .map((s) => opt(s, statusPill(s).replace(/<[^>]+>/g, ""), status))
      .join("")}</select>
<button type="submit" class="sub">絞り込む</button>${filtered ? `<a class="btn sub" href="/admin/readers">${icon("x", 14)}クリア</a>` : ""}</form>
${rows.length ? "" : emptyState(filtered
      ? { icon: "search", title: "条件に合う読者はいません", text: "条件を変えるか、クリアしてください。" }
      : { icon: "users", title: "まだ読者がいません", text: "フォームから登録があるか、既存のリストを CSV で取り込むと、ここに並びます。", action: linkButton("/admin/readers/new?tab=csv", "CSV で取り込む", "upload", true) + " " + linkButton("/admin/readers/new", "読者を追加", "user-plus") })}
${rows.length ? `<form method="post" action="/admin/readers/bulk-tag" id="bulk">
<input type="hidden" name="back" value="/admin/readers${h(qs(page))}">
<div class="bulk-bar"><span class="muted">選んだ読者に</span>
<input type="text" name="tag" list="all-tags" placeholder="タグを選ぶか、新しく入力" maxlength="40" aria-label="タグ" required>
<datalist id="all-tags">${tags.map((t) => `<option value="${h(t.name)}"></option>`).join("")}</datalist>
<button type="submit" name="op" value="add">${icon("tag", 16)}付ける</button><button type="submit" name="op" value="remove" class="sub">外す</button></div>
<div class="wrap"><table><tr><th><input type="checkbox" aria-label="このページの全員を選ぶ" onclick="for(const x of document.querySelectorAll('#bulk input[name=ids]'))x.checked=this.checked"></th><th>メールアドレス</th><th>名前</th><th>状態</th><th>区分</th><th>スコア</th><th>タグ</th><th>登録日</th></tr>
${rows
  .map(
    (r) => `<tr><td><input type="checkbox" name="ids" value="${h(r.id)}" aria-label="選ぶ"></td><td><span class="who">${avatar(r.display_name || r.address || "?")}<a href="/admin/readers/${h(r.id)}">${h(r.address ?? "（なし）")}</a></span></td><td>${h(r.display_name)}</td>
<td>${statusPill(r.status)}</td><td>${tierPill(r.tier)}</td><td>${h(Number(r.score).toFixed(1))}</td>
<td>${r.tags.map((t) => `<span class="pill">${h(t)}</span>`).join("")}</td><td>${h(jst(r.created_at))}</td></tr>`,
  )
  .join("")}</table></div></form>` : ""}
<div class="actions">${page > 1 ? `<a class="btn sub" href="/admin/readers${qs(page - 1)}">前へ</a>` : ""}${
      rows.length === 50 ? `<a class="btn sub" href="/admin/readers${qs(page + 1)}">次へ</a>` : ""
    }<span class="muted">${page} ページ目</span></div>`;
    return c.html(adminPage({ title: "読者", active: "/admin/readers", body, flash: flashFrom(c) }));
  });

  app.get("/readers/:id", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const [r] = await ctx.db.query<{
      id: string;
      display_name: string | null;
      source: string | null;
      status: string;
      tier: string;
      score: string;
      no_response_streak: number;
      attributes: Record<string, unknown>;
      created_at: Date;
    }>("SELECT * FROM contacts WHERE id::text = $1", [id]);
    if (!r) return c.html(adminPage({ title: "読者", active: "/admin/readers", body: `${emptyState({ icon: "circle-x", title: "見つかりません", text: "削除されたか、URL が間違っている可能性があります。" })}` }), 404);
    const channels = await ctx.db.query<{ kind: string; address: string; status: string }>(
      "SELECT kind, address, status FROM channels WHERE contact_id = $1",
      [r.id],
    );
    const allTags = await tagsWithCounts(ctx);
    const tags = await ctx.db.query<{ id: string; name: string; reason: string; tagged_at: Date }>(
      "SELECT t.id, t.name, ct.reason, ct.tagged_at FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1 ORDER BY t.name",
      [r.id],
    );
    const [latest] = await ctx.db.query<{ day: string; breakdown: Record<string, number> }>(
      "SELECT day::text, breakdown FROM score_history WHERE contact_id = $1 ORDER BY day DESC LIMIT 1",
      [r.id],
    );
    const enrollments = await ctx.db.query<{ name: string; status: string; next_position: number; next_send_at: Date | null }>(
      "SELECT s.name, e.status, e.next_position, e.next_send_at FROM enrollments e JOIN sequences s ON s.id = e.sequence_id WHERE e.contact_id = $1 ORDER BY e.enrolled_at DESC",
      [r.id],
    );
    const events = await ctx.db.query<{ type: string; machine: boolean; bot_reason: string | null; data: Record<string, unknown>; occurred_at: Date }>(
      "SELECT type, machine, bot_reason, data, occurred_at FROM events WHERE contact_id = $1 ORDER BY occurred_at DESC LIMIT 50",
      [r.id],
    );
    const prefs = await ctx.db.query<{ name: string; subscribed: boolean }>(
      `SELECT t.name, COALESCE(p.subscribed, t.default_subscribed) AS subscribed
         FROM topics t LEFT JOIN contact_topic_prefs p ON p.topic_id = t.id AND p.contact_id = $1 ORDER BY t.position, t.created_at`,
      [r.id],
    );
    const [pause] = await ctx.db.query<{ paused_until: Date | null }>("SELECT paused_until FROM contacts WHERE id = $1", [r.id]);
    const pausedUntil = pause?.paused_until && new Date(pause.paused_until) > ctx.now() ? pause.paused_until : null;
    const consents = await ctx.db.query<{ method: string; consent_text_version: string; evidence: Record<string, unknown> | null; form_name: string | null; consented_at: Date; confirmed_at: Date | null; revoked_at: Date | null }>(
      `SELECT co.method, co.consent_text_version, co.evidence, f.name AS form_name, co.consented_at, co.confirmed_at, co.revoked_at
         FROM consents co JOIN channels ch ON ch.id = co.channel_id LEFT JOIN forms f ON f.id = co.form_id
        WHERE ch.contact_id = $1 ORDER BY co.consented_at DESC`,
      [r.id],
    );
    const b = latest?.breakdown;
    const EVENT: Record<string, string> = {
      delivered: "配達", open: "開封", click: "クリック", read: "読了", goal: "目標行動", reply: "返信", bounce: "バウンス",
      complaint: "苦情", unsubscribe: "配信停止", subscribe: "登録", resubscribe: "再登録",
    };
    const body = `${pageHeader({ title: channels.find((x) => x.kind === "email")?.address ?? "読者", back: ["/admin/readers", "読者"] })}
<div class="grid">
  <div class="stat"><b>${statusPill(r.status)}</b><span>状態</span></div>
  <div class="stat"><b>${tierPill(r.tier)}</b><span>区分</span></div>
  <div class="stat"><b>${h(Number(r.score).toFixed(1))}</b><span>読者スコア</span></div>
  <div class="stat"><b>${r.no_response_streak}</b><span>連続未反応</span></div>
</div>
<div class="card"><div class="row">
<div><span class="muted">名前</span><div>${h(r.display_name ?? "—")}</div></div>
<div><span class="muted">流入元</span><div>${h(r.source ?? "—")}</div></div>
<div><span class="muted">登録日</span><div>${h(jst(r.created_at))}</div></div>
<div><span class="muted">属性</span><div><code>${h(JSON.stringify(r.attributes))}</code></div></div>
</div>
${b ? `<p class="muted">スコアの内訳（${h(latest!.day)}）：行動点 ${h(b.activityPoints?.toFixed(1))} → 活動 ${h(((b.activityTerm ?? 0) * 100).toFixed(0))}%、クリック率 ${h(((b.clickRateTerm ?? 0) * 100).toFixed(0))}%、読了率 ${h(((b.readRateTerm ?? 0) * 100).toFixed(0))}%（いずれも満点に対する割合）</p>` : `<p class="muted">スコアはまだ計算されていません（毎日 3 時に更新）。</p>`}
<div class="actions">
${r.status === "active" || r.status === "pending" || r.status === "paused" ? `<form method="post" action="/admin/readers/${h(r.id)}/unsubscribe" class="inline" onsubmit="return confirm('この読者を配信停止にしますか？')"><button class="danger" type="submit">配信停止にする</button></form>` : ""}
${r.status === "paused" || r.status === "stopped" ? `<form method="post" action="/admin/readers/${h(r.id)}/resume" class="inline"><button class="sub" type="submit">配信を再開する</button></form>` : ""}
</div></div>
<h2>タグ</h2><div class="card">
${tags.map((t) => `<form method="post" action="/admin/readers/${h(r.id)}/tags/${h(t.id)}/delete" class="inline"><span class="pill">${h(t.name)}<button class="sub" style="border:0;padding:0 0 0 6px" title="外す">×</button></span></form>`).join("") || '<span class="muted">なし</span>'}
<form method="post" action="/admin/readers/${h(r.id)}/tags"><label>付けるタグを選ぶ（押して選び、「付ける」）</label>
${tagPicker({ name: "tags", tags: allTags.filter((t) => !tags.some((x) => x.name === t.name)), selected: [], allowNew: "newTags", empty: "ほかのタグはまだありません" })}
<div class="actions"><button class="sub" type="submit">${icon("tag", 16)}付ける</button></div></form></div>
<h2>配信設定（読者が選んだもの）</h2><div class="card">
${pausedUntil ? `<p><span class="pill warn">お休み中</span> ${h(jst(pausedUntil))} まで</p>` : ""}
${prefs.map((p) => `<span class="pill ${p.subscribed ? "good" : ""}">${h(p.name)}：${p.subscribed ? "受け取る" : "受け取らない"}</span>`).join("") || '<span class="muted">配信の種類はまだありません</span>'}</div>
<h2>シナリオ</h2><div class="wrap"><table><tr><th>シナリオ</th><th>状態</th><th>次の通</th><th>次の送信</th></tr>
${enrollments.map((e) => `<tr><td>${h(e.name)}</td><td>${statusPill(e.status)}</td><td>${e.next_position}</td><td>${h(jst(e.next_send_at))}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">なし</td></tr>'}</table></div>
<h2>同意の記録</h2><div class="wrap"><table><tr><th>方法</th><th>内容</th><th>文言の版</th><th>同意</th><th>確認</th><th>撤回</th></tr>
${consents
  .map((x) => {
    const method = ({ form: "フォーム", import: "CSV の取り込み", manual: "管理画面で追加" } as Record<string, string>)[x.method] ?? x.method;
    const ev = x.evidence ?? {};
    const detail = [x.form_name ? `フォーム「${x.form_name}」` : "", typeof ev.label === "string" ? `取り込み元：${ev.label}` : "", typeof ev.evidence === "string" ? ev.evidence : ""]
      .filter(Boolean)
      .join("／");
    return `<tr><td>${h(method)}</td><td class="muted">${h(detail)}</td><td>${h(x.consent_text_version)}</td><td>${h(jst(x.consented_at))}</td><td>${h(jst(x.confirmed_at))}</td><td>${h(jst(x.revoked_at))}</td></tr>`;
  })
  .join("")}</table></div>
<h2>行動の履歴（新しい順に 50 件）</h2><div class="wrap"><table><tr><th>日時</th><th>行動</th><th>補足</th></tr>
${events
  .map(
    (e) => `<tr><td>${h(jst(e.occurred_at))}</td><td>${h(EVENT[e.type] ?? e.type)}${e.machine ? ' <span class="pill">機械開封</span>' : ""}${e.bot_reason ? ` <span class="pill warn">ボット判定：${h(e.bot_reason)}</span>` : ""}</td><td class="muted">${h(typeof e.data?.url === "string" ? e.data.url : "")}</td></tr>`,
  )
  .join("")}</table></div>`;
    return c.html(adminPage({ title: "読者", active: "/admin/readers", body, flash: flashFrom(c) }));
  });

  app.post("/readers/:id/unsubscribe", async (c) => {
    const ctx = await getCtx();
    await unsubscribe(ctx, c.req.param("id"));
    await audit(ctx.db, "reader.unsubscribe", c.req.param("id"));
    return back(c, `/admin/readers/${c.req.param("id")}`, "ok", "配信停止にしました");
  });

  app.post("/readers/:id/resume", async (c) => {
    const ctx = await getCtx();
    // 配信停止・苦情・不達の読者は再開しない（本人の再登録が必要）
    const rows = await ctx.db.query(
      `UPDATE contacts SET status = 'active', tier = CASE WHEN tier = 'dormant' THEN 'low' ELSE tier END, no_response_streak = 0, updated_at = now()
        WHERE id::text = $1 AND status IN ('paused','stopped')
          AND EXISTS (SELECT 1 FROM channels WHERE contact_id = contacts.id AND kind = 'email' AND status = 'active')
        RETURNING id`,
      [c.req.param("id")],
    );
    await audit(ctx.db, "reader.resume", c.req.param("id"));
    return back(c, `/admin/readers/${c.req.param("id")}`, rows.length ? "ok" : "err", rows.length ? "配信を再開しました" : "この読者は再開できません（アドレスが不達・苦情・停止の状態です）");
  });

  app.post("/readers/:id/tags", async (c) => {
    const ctx = await getCtx();
    const names = tagsFrom(await readForm(c), "tags", "newTags", "tag");
    if (!names.length) return back(c, `/admin/readers/${c.req.param("id")}`, "err", "付けるタグを選ぶか、入力してください（40 文字以内）");
    for (const name of names) {
      await ctx.db.query("INSERT INTO contact_tags (contact_id, tag_id, reason) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING", [
        c.req.param("id"),
        await tagIdFor(ctx, name),
      ]);
    }
    await audit(ctx.db, "reader.tag_add", c.req.param("id"), { tags: names });
    return back(c, `/admin/readers/${c.req.param("id")}`, "ok", `タグ「${names.join("」「")}」を付けました`);
  });

  // 読者一覧で選んだ人に、まとめてタグを付ける・外す
  app.post("/readers/bulk-tag", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const backTo = one(f, "back").startsWith("/admin/readers") ? one(f, "back") : "/admin/readers";
    const ids = many(f, "ids").filter((x) => /^[0-9a-f-]{36}$/.test(x));
    const name = one(f, "tag");
    if (!ids.length) return back(c, backTo, "err", "読者を選んでください（左のチェック）");
    if (!name || name.length > 40) return back(c, backTo, "err", "タグを選ぶか入力してください（40 文字以内）");
    if (one(f, "op") === "remove") {
      const r = await ctx.db.query(
        "DELETE FROM contact_tags WHERE tag_id = (SELECT id FROM tags WHERE name = $1) AND contact_id::text = ANY($2::text[]) RETURNING contact_id",
        [name, ids],
      );
      await audit(ctx.db, "reader.bulk_tag_remove", undefined, { tag: name, count: r.length });
      return back(c, backTo, "ok", `${r.length} 人からタグ「${name}」を外しました`);
    }
    const tagId = await tagIdFor(ctx, name);
    const r = await ctx.db.query(
      `INSERT INTO contact_tags (contact_id, tag_id, reason)
       SELECT id, $1, 'manual' FROM contacts WHERE id::text = ANY($2::text[]) ON CONFLICT DO NOTHING RETURNING contact_id`,
      [tagId, ids],
    );
    await audit(ctx.db, "reader.bulk_tag_add", undefined, { tag: name, count: r.length });
    return back(c, backTo, "ok", `${r.length} 人にタグ「${name}」を付けました${r.length < ids.length ? `（${ids.length - r.length} 人は付いていました）` : ""}`);
  });

  app.post("/readers/:id/tags/:tagId/delete", async (c) => {
    const ctx = await getCtx();
    await ctx.db.query("DELETE FROM contact_tags WHERE contact_id::text = $1 AND tag_id::text = $2", [c.req.param("id"), c.req.param("tagId")]);
    await audit(ctx.db, "reader.tag_remove", c.req.param("id"), { tagId: c.req.param("tagId") });
    return back(c, `/admin/readers/${c.req.param("id")}`, "ok", "タグを外しました");
  });

  // ---- 配信ログ ----
  registerMailLogs(app, getCtx);
  app.get("/logs/messages", async (c) => {
    const ctx = await getCtx();
    const STATUSES = ["queued", "sent", "delivered", "bounced", "complained", "failed", "skipped"];
    const status = STATUSES.includes(c.req.query("status") ?? "") ? c.req.query("status")! : "";
    const per = [25, 50, 100].includes(Number(c.req.query("per"))) ? Number(c.req.query("per")) : 50;
    const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
    const where = status ? "m.status = $1" : "TRUE";
    const base = status ? [status] : [];
    const [{ total } = { total: 0 }] = await ctx.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM messages m WHERE ${where}`, base);
    const pages = Math.max(1, Math.ceil(total / per));
    const cur = Math.min(page, pages);
    const rows = await ctx.db.query<{
      id: string;
      kind: string;
      status: string;
      error: string | null;
      attempts: number;
      queued_at: Date;
      sent_at: Date | null;
      address: string;
      contact_id: string;
      title: string | null;
      origin: string | null;
    }>(
      `SELECT m.id, m.kind, m.status, m.error, m.attempts, m.queued_at, m.sent_at, ch.address, m.contact_id,
              COALESCE(b.subject, st.subject, f.confirm_subject, m.subject) AS title,
              COALESCE(sq.name, f.name) AS origin
         FROM messages m JOIN channels ch ON ch.id = m.channel_id
         LEFT JOIN broadcasts b ON b.id = m.broadcast_id
         LEFT JOIN sequence_steps st ON st.id = m.step_id
         LEFT JOIN sequences sq ON sq.id = st.sequence_id
         LEFT JOIN forms f ON f.id = m.form_id
        WHERE ${where} ORDER BY m.queued_at DESC LIMIT ${per} OFFSET ${(cur - 1) * per}`,
      base,
    );
    const KIND: Record<string, string> = { optin: "確認メール", sequence: "シナリオ", broadcast: "一斉配信" };
    const link = (o: { status?: string; per?: number; page?: number }) => {
      const q = new URLSearchParams();
      const st = o.status ?? status;
      if (st) q.set("status", st);
      const p = o.per ?? per;
      if (p !== 50) q.set("per", String(p));
      const pg = o.page ?? 1;
      if (pg > 1) q.set("page", String(pg));
      const qs = q.toString();
      return `/admin/logs/messages${qs ? `?${qs}` : ""}`;
    };
    const filters = tabs(
      ["", ...STATUSES].map((st) => ({
        href: link({ status: st }),
        label: st ? statusPill(st).replace(/<[^>]+>/g, "") : "すべて",
        current: st === status,
      })),
    );
    const from = total === 0 ? 0 : (cur - 1) * per + 1;
    const to = Math.min(total, cur * per);
    const pager = `<div class="log-bar"><span class="muted">全 ${total.toLocaleString("ja-JP")} 件中 ${from.toLocaleString("ja-JP")}–${to.toLocaleString("ja-JP")} 件</span>
<span class="log-per">表示件数 ${[25, 50, 100].map((n) => (n === per ? `<b>${n}</b>` : `<a href="${link({ per: n })}">${n}</a>`)).join("")}</span>
<span class="log-pages">${cur > 1 ? `<a class="btn sub" href="${link({ page: cur - 1 })}">${icon("arrow-left", 14)}前へ</a>` : ""}<span class="muted">${cur} / ${pages} ページ</span>${cur < pages ? `<a class="btn sub" href="${link({ page: cur + 1 })}">次へ${icon("arrow-right", 14)}</a>` : ""}</span></div>`;
    const body = `${pageHeader({ title: "配信ログ", desc: "1 通ずつの送信記録です。エラーがあるメールは「送信待ち」のまま自動で再試行され、3 回失敗すると「失敗」になります。" })}
${logViewTabs("messages")}
<style>
.log-bar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);margin:var(--space-3) 0}
.log-per{display:inline-flex;gap:var(--space-2);align-items:center;font-size:13px;color:var(--ink-muted)}.log-per a,.log-per b{padding:2px 8px;border-radius:var(--radius-pill)}.log-per b{background:var(--accent-soft);color:var(--accent)}
.log-pages{margin-left:auto;display:inline-flex;gap:var(--space-2);align-items:center}.log-pages .btn{height:30px;padding:0 var(--space-3);font-size:13px}
.log-table td{white-space:normal;vertical-align:top}.log-table .sub-line{display:block;color:var(--ink-muted);font-size:12px;line-height:18px;margin-top:2px}
.log-table .kind{display:inline-block;font-size:11px;padding:0 6px;border-radius:var(--radius-pill);background:var(--surface-sunken);color:var(--ink-muted);margin-right:6px;vertical-align:1px}
</style>
${filters}
${rows.length ? pager : ""}
${rows.length ? "" : emptyState({ icon: "scroll-text", title: "該当する送信記録はありません", text: "メールを送ると、ここに 1 通ずつ記録が並びます。" })}
${rows.length ? `<div class="wrap"><table class="log-table"><tr><th style="width:150px">日時</th><th>メール</th><th>宛先</th><th style="width:220px">状態</th></tr>
${rows
  .map(
    (r) => `<tr><td>${h(jst(r.sent_at ?? r.queued_at))}</td>
<td><span class="kind">${h(KIND[r.kind] ?? r.kind)}</span>${h(r.title || "（件名なし）")}${r.origin && r.kind !== "broadcast" ? `<span class="sub-line">${h(r.origin)}</span>` : ""}</td>
<td><a href="/admin/readers/${h(r.contact_id)}">${h(r.address)}</a></td>
<td>${statusPill(r.status)}${r.error || r.attempts > 1 ? `<span class="sub-line">${h(r.error ?? "")}${r.attempts > 1 ? `（${r.attempts} 回目）` : ""}</span>` : ""}</td></tr>`,
  )
  .join("")}</table></div>${pager}` : ""}`;
    return c.html(adminPage({ title: "配信ログ", active: "/admin/logs", body }));
  });

  // ---- 置き換え文字 ----
  app.get("/variables", async (c) => {
    const ctx = await getCtx();
    const vars = await ctx.db.query<{ key: string; value: string; kind: string; note: string | null }>(
      "SELECT key, value, kind, note FROM custom_variables ORDER BY key",
    );
    const body = `${pageHeader({ title: "置き換え文字", desc: "本文に %名前% のように書くと、送信時に登録した値へ置き換わります。" })}
<p class="muted">本文に <code>%名前%</code> のように書くと、送信時に下の値へ置き換わります。組み込みの <code>%cancel%</code>（配信解除）や <code>%name%</code>（呼び名）などは登録不要です（一覧は docs/content.md）。</p>
<div class="wrap"><table><tr><th>書き方</th><th>値</th><th>種類</th><th>メモ</th><th></th></tr>
${vars
  .map(
    (v) => `<tr><td><code>%${h(v.key)}%</code></td><td style="white-space:pre-wrap">${h(v.value)}</td><td>${v.kind === "url" ? "URL" : "文字"}</td><td class="muted">${h(v.note)}</td>
<td><form method="post" action="/admin/variables/${encodeURIComponent(v.key)}/delete" onsubmit="return confirm('削除しますか？使っているメールは送信できなくなります')"><button class="danger" type="submit">削除</button></form></td></tr>`,
  )
  .join("")}</table></div>
<h2>追加・更新</h2><form method="post" action="/admin/variables" class="card">
<div class="row"><div><label>名前（%と%の間）</label><input type="text" name="key" required maxlength="40" placeholder="lp_url"></div>
<div><label>種類</label><select name="kind"><option value="text">文字</option><option value="url">URL</option></select></div></div>
<label>値</label><textarea name="value" style="min-height:90px" required></textarea>
<label>メモ（任意）</label><input type="text" name="note" maxlength="100">
<div class="actions"><button type="submit">保存する</button></div></form>`;
    return c.html(adminPage({ title: "置き換え文字", active: "/admin/variables", body, flash: flashFrom(c) }));
  });

  app.post("/variables", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const key = one(f, "key");
    const problem = validateCustomKey(key) ?? (await setCustomVariable(ctx.db, key, one(f, "value"), one(f, "kind") === "url" ? "url" : "text", one(f, "note") || undefined));
    if (problem) return back(c, "/admin/variables", "err", problem);
    await audit(ctx.db, "variable.set", key);
    return back(c, "/admin/variables", "ok", `%${key}% を保存しました`);
  });

  app.post("/variables/:key/delete", async (c) => {
    const ctx = await getCtx();
    await deleteCustomVariable(ctx.db, c.req.param("key"));
    await audit(ctx.db, "variable.delete", c.req.param("key"));
    return back(c, "/admin/variables", "ok", "削除しました");
  });

  // ---- 設定 ----
  app.get("/settings", async (c) => {
    const ctx = await getCtx();
    const s = ctx.settings;
    const sc = await loadScoreSettings(ctx);
    const num = (name: string, value: number, label: string, step = "1") =>
      `<div><label>${label}</label><input type="number" name="${name}" value="${value}" step="${step}"></div>`;
    const body = `${pageHeader({ title: "設定", desc: "送信者の表示・法定表記・テスト送信先・スコアの基準を変えられます。" })}
<form method="post" action="/admin/settings" class="card"><h2 style="margin-top:0">送信者の表示</h2>
<div class="row"><div><label>送信元アドレス</label><input type="email" name="fromAddress" value="${h(s.fromAddress)}" required></div>
<div><label>受信箱に出る送信者名</label><input type="text" name="fromName" value="${h(s.fromName)}" maxlength="60"></div>
<div><label>返信先（任意）</label><input type="email" name="replyTo" value="${h(s.replyTo)}"></div></div>
<div class="row"><div><label>送信者の氏名・名称（法定表示）</label><input type="text" name="senderName" value="${h(s.senderName)}" required></div>
<div><label>問い合わせ先（URL かメールアドレス）</label><input type="text" name="contact" value="${h(s.contact)}" required></div></div>
<div class="row"><div><label>送信者情報ページの URL（任意。無ければ /legal に住所を表示）</label><input type="url" name="senderInfoUrl" value="${h(s.senderInfoUrl)}"></div>
<div><label>住所（/legal ページに表示。メール本文には出ません）</label><input type="text" name="senderAddress" value="${h(s.senderAddress)}"></div></div>
<div class="row"><div><label>呼び名が無い読者の呼び方</label><input type="text" name="defaultName" value="${h(s.defaultName)}" maxlength="20"></div>
<div><label>テスト送信先（カンマ区切り。サンドボックス中は SES で検証済みのアドレスのみ）</label><input type="text" name="testRecipients" value="${h((s.testRecipients ?? []).join(", "))}"></div></div>
<div class="actions"><button type="submit">保存する</button></div></form>

<form method="post" action="/admin/settings/score" class="card"><h2 style="margin-top:0">読者スコア</h2>
<p class="muted">数値はすべて初期値（仮置き）です。保存すると、次の毎日 3 時の再計算から反映されます。</p>
<div class="row">${num("w_click", sc.weights.click, "クリックの点")}${num("w_read", sc.weights.read, "読了の点")}${num("w_goal", sc.weights.goal, "目標行動の点")}${num("w_humanOpen", sc.weights.humanOpen, "開封の点", "0.1")}${num("w_ignored", sc.weights.ignored, "未反応の点（負の値）", "0.1")}</div>
<div class="row">${num("halfLifeDays", sc.halfLifeDays, "半減期（日）")}${num("t_hot", sc.tiers.hot, "熱心の下限")}${num("t_normal", sc.tiers.normal, "通常の下限")}${num("t_low", sc.tiers.low, "低下の下限")}${num("dormantNoResponseStreak", sc.dormantNoResponseStreak, "休眠とする連続未反応数")}</div>
<div class="actions"><button type="submit">保存する</button></div></form>`;
    return c.html(adminPage({ title: "設定", active: "/admin/settings", body, flash: flashFrom(c) }));
  });

  app.post("/settings", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const httpsOrEmpty = (v: string) => v === "" || /^https:\/\//.test(v);
    if (!httpsOrEmpty(one(f, "senderInfoUrl"))) return back(c, "/admin/settings", "err", "送信者情報ページの URL は https:// で始めてください");
    const updates: Partial<AppSettings> = {
      fromAddress: one(f, "fromAddress"),
      fromName: one(f, "fromName"),
      senderName: one(f, "senderName"),
      contact: one(f, "contact"),
      defaultName: one(f, "defaultName"),
      testRecipients: list(one(f, "testRecipients")).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)).slice(0, 5),
      ...(one(f, "replyTo") ? { replyTo: one(f, "replyTo") } : {}),
      ...(one(f, "senderInfoUrl") ? { senderInfoUrl: one(f, "senderInfoUrl") } : {}),
      ...(one(f, "senderAddress") ? { senderAddress: one(f, "senderAddress") } : {}),
    };
    // 画面に無い項目（footerExtraLines など）は残し、空にした任意項目は消す
    const [cur] = await ctx.db.query<{ settings: Partial<AppSettings> }>("SELECT settings FROM app_settings WHERE id = 1");
    const merged: Record<string, unknown> = { ...(cur?.settings ?? {}), ...updates };
    for (const k of ["replyTo", "senderInfoUrl", "senderAddress"] as const) if (!one(f, k)) delete merged[k];
    await ctx.db.query(
      "INSERT INTO app_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()",
      [JSON.stringify(merged)],
    );
    ctx.settings = { ...ctx.settings, ...updates };
    for (const k of ["replyTo", "senderInfoUrl", "senderAddress"] as const) if (!one(f, k)) delete ctx.settings[k];
    await refreshSettings(ctx);
    await audit(ctx.db, "settings.update");
    return back(c, "/admin/settings", "ok", "保存しました");
  });

  app.post("/settings/score", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const cur = await loadScoreSettings(ctx);
    const n = (k: string, fallback: number) => {
      const v = Number(one(f, k));
      return Number.isFinite(v) ? v : fallback;
    };
    const next: ScoreSettings = {
      ...defaultScoreSettings,
      ...cur,
      weights: {
        ...cur.weights,
        click: n("w_click", cur.weights.click),
        read: n("w_read", cur.weights.read),
        goal: n("w_goal", cur.weights.goal),
        humanOpen: n("w_humanOpen", cur.weights.humanOpen),
        ignored: Math.min(0, n("w_ignored", cur.weights.ignored)),
      },
      halfLifeDays: Math.max(1, n("halfLifeDays", cur.halfLifeDays)),
      tiers: { hot: n("t_hot", cur.tiers.hot), normal: n("t_normal", cur.tiers.normal), low: n("t_low", cur.tiers.low) },
      dormantNoResponseStreak: Math.max(1, Math.round(n("dormantNoResponseStreak", cur.dormantNoResponseStreak))),
    };
    if (!(next.tiers.hot > next.tiers.normal && next.tiers.normal > next.tiers.low && next.tiers.low > 0)) {
      return back(c, "/admin/settings", "err", "区分の下限は 熱心 > 通常 > 低下 > 0 の順にしてください");
    }
    await ctx.db.query(
      "INSERT INTO score_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()",
      [JSON.stringify(next)],
    );
    await ctx.db.query("INSERT INTO score_settings_history (settings) VALUES ($1)", [JSON.stringify(next)]);
    await audit(ctx.db, "score_settings.update");
    return back(c, "/admin/settings", "ok", "読者スコアの設定を保存しました");
  });

  registerBroadcasts(app, getCtx);
  registerFooters(app, getCtx);
  registerDomains(app, getCtx);
  registerRoutes(app, getCtx);
  registerGroups(app, getCtx);
  registerAutomations(app, getCtx);
  registerTopics(app, getCtx);
  registerContent(app, getCtx, opts);
  return app;
}

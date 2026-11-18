import { emailDomain, isDomainName, sesDnsRecords } from "@tsuzuri/core";
import type { Hono } from "hono";
import { senderDomains, type AppContext, type IdentityStatus } from "../context.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, h, pageHeader } from "./ui.js";

/**
 * 送信ドメイン：シナリオ・一斉配信ごとに、別のドメインの送信元アドレスから送るための登録。
 * ここでは「どのドメインを使うか」と、SES の状態・DNS に入れるレコードの表示だけを行う。
 * SES の ID の作成と送信の権限は AWS 側（infra/tsuzuri.local.json の tsuzuri:extraSendingDomains → TsuzuriVps のデプロイ）で行う。
 * VPS の鍵に SES の ID を作る権限を持たせないため（鍵が漏れたときの被害を小さくする）。
 */

const STATUS_LABEL: Record<string, string> = {
  SUCCESS: "成功",
  PENDING: "確認中",
  FAILED: "失敗",
  TEMPORARY_FAILURE: "一時的な失敗",
  NOT_STARTED: "未開始",
};

async function usage(ctx: AppContext, domain: string): Promise<{ sequences: number; broadcasts: number }> {
  const [r] = await ctx.db.query<{ sequences: number; broadcasts: number }>(
    `SELECT (SELECT count(*) FROM sequences WHERE lower(from_address) LIKE $1)::int AS sequences,
            (SELECT count(*) FROM broadcasts WHERE lower(from_address) LIKE $1 AND status IN ('draft','scheduled'))::int AS broadcasts`,
    [`%@${domain}`],
  );
  return r ?? { sequences: 0, broadcasts: 0 };
}

function statusPills(st: IdentityStatus | undefined): string {
  if (!st) return '<span class="pill">状態を確認できません</span>';
  if (st.error) return `<span class="pill bad">確認できません</span> <span class="muted">${h(st.error)}</span>`;
  if (!st.found) return '<span class="pill warn">AWS に未登録</span>';
  const p = (label: string, s: string | undefined) =>
    `<span class="pill ${s === "SUCCESS" ? "good" : s === "FAILED" ? "bad" : "warn"}">${label}：${h(STATUS_LABEL[s ?? ""] ?? s ?? "?")}</span>`;
  return `${st.verified ? '<span class="pill good">送信できます</span>' : '<span class="pill warn">まだ送信できません</span>'}${p("DKIM", st.dkimStatus)}${p("MAIL FROM", st.mailFromStatus)}`;
}

export function registerDomains(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/domains", async (c) => {
    const ctx = await getCtx();
    const defaultDomain = emailDomain(ctx.settings.fromAddress);
    const domains = senderDomains(ctx);
    const cards: string[] = [];
    for (const d of domains) {
      const isDefault = d === defaultDomain;
      const st: IdentityStatus | undefined = ctx.identityStatus
        ? await ctx.identityStatus(d).catch((e: unknown): IdentityStatus => ({ found: false, error: e instanceof Error ? e.message : String(e) }))
        : undefined;
      const used = await usage(ctx, d);
      const records = st?.found && st.dkimTokens?.length ? sesDnsRecords(d, st.dkimTokens) : [];
      const table = records.length
        ? `<div class="wrap"><table class="dns-table"><tr><th>種類</th><th>名前（ホスト）</th><th>値</th><th>用途</th></tr>${records
            .map(
              (r, i) => `<tr><td>${r.type}</td><td><code id="n-${h(d)}-${i}">${h(r.name)}</code> <button type="button" class="sub copy" data-copy="n-${h(d)}-${i}" title="コピー">${icon("copy", 14)}</button></td>
<td><code id="v-${h(d)}-${i}">${h(r.value)}</code> <button type="button" class="sub copy" data-copy="v-${h(d)}-${i}" title="コピー">${icon("copy", 14)}</button></td><td class="muted">${h(r.purpose)}</td></tr>`,
            )
            .join("")}</table></div>
<p class="muted">DNS の管理画面で、上のレコードを登録してください（MX の「10」は優先度の欄に入れます）。反映には数分〜数時間かかり、SES が自動で確認すると状態が「成功」に変わります。すでに同じ名前の DMARC があれば、DMARC は足さなくてかまいません。</p>`
        : st && !st.found && !st.error
          ? `<ol class="steps"><li>PC 側で <code>infra/tsuzuri.local.json</code> の <code>"tsuzuri:extraSendingDomains"</code> に <code>"${h(d)}"</code> を足します。</li>
<li><code>TsuzuriVps</code> をデプロイします（SES にドメインが登録され、VPS がこのドメインから送れるようになります）。</li>
<li>このページを開き直すと、DNS に入れるレコードが表示されます。</li></ol>`
          : "";
      // 設定が終わったドメインは閉じておき、設定中（未登録・確認中）のときだけ開いて見せる
      const settingUp = !!st && !st.error && (!st.found || !st.verified);
      const guide = table
        ? `<details class="dns-box"${settingUp ? " open" : ""}><summary>${icon(records.length ? "list-checks" : "info", 14)}${
            records.length ? "DNS レコードと設定方法" : "AWS 側の登録手順"
          }<span class="muted">${settingUp ? "（設定が終わるまで開いています）" : "（設定済み。必要なときに開いて確認できます）"}</span></summary><div class="dns-body">${table}</div></details>`
        : "";
      const uses = used.sequences + used.broadcasts;
      const remove =
        !isDefault
          ? `<form method="post" action="/admin/domains/remove" class="inline" onsubmit="return confirm('${h(d)} を送信ドメインから外しますか？（AWS 側の登録は残ります）')"><input type="hidden" name="domain" value="${h(d)}"><button type="submit" class="danger"${uses ? ` disabled title="使っているシナリオ・一斉配信があります"` : ""}>外す</button></form>`
          : "";
      cards.push(`<section class="card"><div class="domain-head"><h2>${h(d)}</h2>${isDefault ? '<span class="pill">既定（設定の送信元）</span>' : ""}<span style="flex:1"></span>${remove}</div>
<div>${statusPills(st)}</div>
<p class="muted">使っているシナリオ ${used.sequences} 件・一斉配信（下書き・予約）${used.broadcasts} 件${isDefault ? "。送信者を変えていないシナリオ・一斉配信もこのドメインから送ります" : ""}</p>
${guide}</section>`);
    }
    const body = `${pageHeader({ title: "送信ドメイン", desc: "シナリオや一斉配信ごとに、別のドメインのアドレスから送るためのドメインです。" })}
<style>
.domain-head{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}.domain-head h2{margin:0;font-family:var(--font-mono);font-size:18px}
.dns-table td{white-space:normal;word-break:break-all;vertical-align:top}.dns-table code{font-family:var(--font-mono);font-size:12px}
.dns-table button.copy{height:24px;padding:0 6px;vertical-align:middle}
.steps{margin:var(--space-3) 0 0;padding-left:1.4em;line-height:1.9}.steps code{font-family:var(--font-mono);font-size:12px}
.dns-box{margin-top:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-sm)}
.dns-box summary{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;padding:var(--space-2) var(--space-3);cursor:pointer;font-weight:500;list-style:none}
.dns-box summary::-webkit-details-marker{display:none}
.dns-box summary::after{content:"";margin-left:auto;width:8px;height:8px;border-right:2px solid var(--ink-muted);border-bottom:2px solid var(--ink-muted);transform:rotate(45deg);transition:transform .15s}
.dns-box[open] summary::after{transform:rotate(-135deg)}
.dns-box summary .muted{font-weight:400}
.dns-body{padding:0 var(--space-3) var(--space-3)}
</style>
${ctx.identityStatus ? "" : `<section class="card"><p class="muted" style="margin:0">${icon("info", 14)} AWS の認証情報が無いため、SES の状態は表示できません（VPS では表示されます）。</p></section>`}
${cards.join("\n")}
<section class="card"><h2>ドメインを追加</h2>
<p class="muted" style="margin:0">送信専用のサブドメイン（例 <code>news.example.jp</code>）をおすすめします。普段のメールと評判を分けられ、既存のメールの設定に影響しません。</p>
<form method="post" action="/admin/domains" class="row" style="align-items:flex-end"><div><label>ドメイン</label><input type="text" name="domain" placeholder="news.example.jp" required></div><div style="flex:0"><button type="submit">${icon("plus", 16)}追加</button></div></form>
<p class="muted">追加したら、上に出る手順で AWS 側の登録（デプロイ）と DNS の設定を行います。送信元アドレスに使えるのは、状態が「送信できます」になってからです。</p></section>
<script>document.querySelectorAll('button.copy').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.dataset.copy).textContent;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.classList.add('done');setTimeout(function(){b.classList.remove('done')},1200)}).catch(function(){})})});</script>`;
    return c.html(adminPage({ title: "送信ドメイン", active: "/admin/domains", body, flash: flashFrom(c) }));
  });

  const saveDomains = async (ctx: AppContext, list: string[]) => {
    await ctx.db.query(
      `INSERT INTO app_settings (id, settings) VALUES (1, jsonb_build_object('sendingDomains', $1::jsonb))
       ON CONFLICT (id) DO UPDATE SET settings = app_settings.settings || jsonb_build_object('sendingDomains', $1::jsonb), updated_at = now()`,
      [JSON.stringify(list)],
    );
    ctx.settings = { ...ctx.settings, sendingDomains: list };
  };

  app.post("/domains", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const d = one(f, "domain").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
    if (!isDomainName(d)) return back(c, "/admin/domains", "err", "ドメインの形を確認してください（例 news.example.jp）");
    if (senderDomains(ctx).includes(d)) return back(c, "/admin/domains", "err", "そのドメインはもう登録されています");
    const cur = ctx.settings.sendingDomains ?? [];
    if (cur.length >= 10) return back(c, "/admin/domains", "err", "追加できる送信ドメインは 10 個までです");
    await saveDomains(ctx, [...cur, d]);
    await audit(ctx.db, "domain.add", d);
    return back(c, "/admin/domains", "ok", `${d} を追加しました。表示される手順で AWS 側の登録と DNS の設定を行ってください`);
  });

  app.post("/domains/remove", async (c) => {
    const ctx = await getCtx();
    const d = one(await readForm(c), "domain").trim().toLowerCase();
    const cur = ctx.settings.sendingDomains ?? [];
    if (!cur.includes(d)) return back(c, "/admin/domains", "err", "そのドメインは追加の送信ドメインにありません");
    const used = await usage(ctx, d);
    if (used.sequences + used.broadcasts > 0) return back(c, "/admin/domains", "err", "このドメインを使っているシナリオ・一斉配信があるため外せません");
    await saveDomains(ctx, cur.filter((x) => x !== d));
    await audit(ctx.db, "domain.remove", d);
    return back(c, "/admin/domains", "ok", `${d} を外しました（AWS 側の登録は残っています。不要なら tsuzuri.local.json からも外してデプロイします）`);
  });
}

import { footerProblems } from "@tsuzuri/core";
import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { assertTemplatesValid, TemplateError } from "../services/broadcasts.js";
import { listFooters, type Footer } from "../services/footers.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm, renderSample } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, pageHeader } from "./ui.js";

/** フッターで使う置き換え文字（押すと本文の欄に入る） */
const FOOTER_PLACEHOLDERS: [string, string][] = [
  ["%sender%", "送信者名（必須）"],
  ["%cancel%", "配信停止のリンク（必須）"],
  ["%sender_info%", "送信者情報のページ（必須。住所・問い合わせ先を表示）"],
  ["%settings%", "配信設定のリンク"],
  ["%contact%", "問い合わせ先"],
  ["%name%", "読者の呼び名"],
];

const NEW_FOOTER = "このメールは %sender% からお送りしています。\n[配信停止](%cancel%) ｜ [送信者情報](%sender_info%)";

function chips(target: string): string {
  return `<div class="ph-chips">${FOOTER_PLACEHOLDERS.map(
    ([ph, label]) =>
      `<button type="button" class="chip" title="${h(label)}" onclick="var t=document.getElementById('${target}');var s=t.selectionStart||t.value.length;t.value=t.value.slice(0,s)+'${ph}'+t.value.slice(s);t.focus()">${h(ph)}<span>${h(label)}</span></button>`,
  ).join("")}</div>`;
}

async function check(ctx: AppContext, body: string): Promise<string | undefined> {
  if (!body.trim()) return "フッターの本文を入れてください";
  const missing = footerProblems(body);
  if (missing.length) return `フッターに次を入れてください（法定の表示のため）：${missing.join("、")}`;
  try {
    await assertTemplatesValid(ctx, "", body);
  } catch (e) {
    if (e instanceof TemplateError) return e.message;
    throw e;
  }
  return undefined;
}

async function footerCard(ctx: AppContext, f: Footer, uses: number): Promise<string> {
  const sample = await renderSample(ctx, "フッターの見本", "（ここに本文が入ります）", "markdown", f.id);
  const id = `fb-${f.id}`;
  return `<section class="card"><div class="card-head"><h2>${h(f.name)}${f.is_default ? ' <span class="pill good">既定</span>' : ""}</h2><span class="muted">使っている配信 ${uses}</span></div>
<div class="split"><form method="post" action="/admin/footers/${h(f.id)}">
<label for="n-${h(f.id)}">名前</label><input id="n-${h(f.id)}" type="text" name="name" value="${h(f.name)}" required maxlength="40">
<label for="${id}">本文（Markdown。改行はそのまま改行になります）</label><textarea id="${id}" name="body" style="min-height:120px" required>${h(f.body)}</textarea>
${chips(id)}
<div class="actions"><button type="submit">保存する</button></div></form>
<div><div class="phone"><iframe sandbox title="フッターの見本" srcdoc="${h(sample.html)}" style="height:300px"></iframe></div>
<div class="actions">${f.is_default ? "" : `<form method="post" action="/admin/footers/${h(f.id)}/default" class="inline"><button class="sub" type="submit">${icon("star", 16)}既定にする</button></form>`}
${f.is_default ? "" : `<form method="post" action="/admin/footers/${h(f.id)}/delete" class="inline" onsubmit="return confirm('削除しますか？このフッターを選んでいた配信は既定のフッターになります')"><button class="danger" type="submit">削除</button></form>`}</div></div></div></section>`;
}

export function registerFooters(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/footers", async (c) => {
    const ctx = await getCtx();
    const footers = await listFooters(ctx.db);
    const uses = await ctx.db.query<{ footer_id: string; n: number }>(
      `SELECT footer_id, count(*)::int AS n FROM (SELECT footer_id FROM broadcasts UNION ALL SELECT footer_id FROM sequences) x
        WHERE footer_id IS NOT NULL GROUP BY footer_id`,
    );
    const cards = (await Promise.all(footers.map((f) => footerCard(ctx, f, uses.find((u) => u.footer_id === f.id)?.n ?? 0)))).join("");
    const body = `${pageHeader({
      title: "フッター",
      desc: "メールの最後に付く部分のひな形です。一斉配信・シナリオごとに選べます（選ばなければ「既定」）。フッターのリンクはクリック数に数えません。",
    })}
${footers.length ? "" : emptyState({ icon: "panel-bottom", title: "フッターがありません", text: "標準の組み込みフッターで送っています。下から作れます。" })}
${cards}
<section class="card"><h2 class="with-icon">${icon("plus", 16)}新しいフッター</h2>
<form method="post" action="/admin/footers">
<label for="new-name">名前</label><input id="new-name" type="text" name="name" required maxlength="40" placeholder="例：本誌用・キャンペーン用">
<label for="fb-new">本文</label><textarea id="fb-new" name="body" style="min-height:120px" required>${h(NEW_FOOTER)}</textarea>
${chips("fb-new")}
<div class="actions"><button type="submit">作る</button></div></form></section>
<p class="muted">送信者名・配信停止のリンク・送信者情報のページ（住所と問い合わせ先を表示）は、特定電子メール法の表示のため必ず入れます。足りないときは保存できません。</p>`;
    return c.html(adminPage({ title: "フッター", active: "/admin/footers", body, flash: flashFrom(c) }));
  });

  app.post("/footers", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const body = typeof f.body === "string" ? f.body : one(f, "body");
    const err = await check(ctx, body);
    if (err) return back(c, "/admin/footers", "err", err);
    const [row] = await ctx.db.query<{ id: string }>("INSERT INTO footers (name, body) VALUES ($1, $2) RETURNING id", [one(f, "name") || "フッター", body]);
    await audit(ctx.db, "footer.create", row!.id);
    return back(c, "/admin/footers", "ok", "フッターを作りました");
  });

  app.post("/footers/:id", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const f = await readForm(c);
    const body = typeof f.body === "string" ? f.body : one(f, "body");
    const err = await check(ctx, body);
    if (err) return back(c, "/admin/footers", "err", err);
    await ctx.db.query("UPDATE footers SET name = $2, body = $3, updated_at = now() WHERE id::text = $1", [id, one(f, "name") || "フッター", body]);
    await audit(ctx.db, "footer.update", id);
    return back(c, "/admin/footers", "ok", "保存しました");
  });

  app.post("/footers/:id/default", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    await ctx.db.transaction(async (tx) => {
      await tx.query("UPDATE footers SET is_default = false WHERE is_default");
      await tx.query("UPDATE footers SET is_default = true WHERE id::text = $1", [id]);
    });
    await audit(ctx.db, "footer.default", id);
    return back(c, "/admin/footers", "ok", "既定のフッターにしました");
  });

  app.post("/footers/:id/delete", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const rows = await ctx.db.query("DELETE FROM footers WHERE id::text = $1 AND NOT is_default RETURNING id", [id]);
    if (!rows.length) return back(c, "/admin/footers", "err", "既定のフッターは削除できません（先に別のフッターを既定にしてください）");
    await audit(ctx.db, "footer.delete", id);
    return back(c, "/admin/footers", "ok", "削除しました");
  });
}

/** 一斉配信・シナリオの画面で使う、フッターの選択欄 */
export function footerSelect(footers: Footer[], current: string | null | undefined, dis = ""): string {
  const def = footers.find((f) => f.is_default);
  return `<label for="footer_id">フッター（<a href="/admin/footers">ひな形を編集</a>）</label><select id="footer_id" name="footer_id"${dis}>
<option value="">既定${def ? `（${h(def.name)}）` : "（標準）"}</option>${footers
    .filter((f) => !f.is_default)
    .map((f) => `<option value="${h(f.id)}"${f.id === current ? " selected" : ""}>${h(f.name)}</option>`)
    .join("")}</select>`;
}

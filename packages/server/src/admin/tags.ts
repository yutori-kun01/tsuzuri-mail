import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { createTag, deleteTag, hasNameReferences, listTagsWithUsage, mergeTags, renameTag, type TagRow, type TagUsage } from "../services/tags.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, emptyState, h, modal, pageHeader } from "./ui.js";

/**
 * タグの管理。フォーム・シナリオが自動で作ったタグも、ここで名前の変更・統合・削除ができる。
 */

const CATEGORY: Record<string, string> = { src: "登録元", seq: "シナリオ", int: "興味", ch: "チャネル", cust: "手動", other: "その他" };

/** 使っている場所のリンク（短く） */
function usageLinks(u: TagUsage): string {
  const parts = [
    ...u.forms.map((f) => `<a class="use-chip" href="/admin/forms/${h(f.id)}?tab=basic">${icon("file-input", 12)}${h(f.name)}</a>`),
    ...u.sequences.map((s) => `<a class="use-chip" href="/admin/sequences/${h(s.id)}?tab=settings">${icon("flag", 12)}${h(s.name)}（完了）</a>`),
    ...u.rules.map((r) => `<a class="use-chip" href="/admin/automations">${icon("zap", 12)}${h(r.name)}</a>`),
    ...u.steps.map((s) => `<a class="use-chip" href="/admin/sequences/${h(s.sequence_id)}/steps/${h(s.id)}">${icon("split", 12)}${h(s.sequence)} ${s.position} 通目の条件</a>`),
    ...u.broadcasts.map((b) => `<a class="use-chip" href="/admin/broadcasts/${h(b.id)}">${icon("send", 12)}${h(b.subject || "（件名なし）")}の宛先</a>`),
    ...u.segments.map((g) => `<span class="use-chip">${icon("users", 12)}${h(g.name)}</span>`),
  ];
  return parts.length ? `<div class="use-list">${parts.join("")}</div>` : '<span class="muted">—</span>';
}

function tagDialog(t: TagRow, all: TagRow[]): string {
  const others = all.filter((x) => x.id !== t.id);
  const blocked = hasNameReferences(t.usage);
  const detach = [
    t.usage.forms.length ? `フォーム ${t.usage.forms.length} 件の「登録した人に付けるタグ」` : "",
    t.usage.sequences.length ? `シナリオ ${t.usage.sequences.length} 件の「完了タグ」` : "",
  ].filter(Boolean);
  return modal({
    id: `tag-${t.id}`,
    title: `タグ「${t.name}」`,
    body: `<form method="post" action="/admin/tags/${h(t.id)}/rename"><label>名前を変える</label>
<div class="copy-row"><input type="text" name="name" value="${h(t.name)}" required maxlength="60"><button type="submit">変更</button></div>
<p class="muted" style="margin:4px 0 0">自動化のルール・ステップの条件・一斉配信の宛先に書かれた名前も、合わせて新しい名前に変わります。</p></form>
${
  others.length
    ? `<form method="post" action="/admin/tags/${h(t.id)}/merge" onsubmit="return confirm('「${h(t.name)}」を選んだタグにまとめて、「${h(t.name)}」は削除します。よろしいですか？')"><label>別のタグにまとめる（統合）</label>
<div class="copy-row"><select name="into" required><option value="">まとめ先を選ぶ</option>${others.map((o) => `<option value="${h(o.id)}">${h(o.name)}</option>`).join("")}</select><button type="submit" class="sub">統合</button></div>
<p class="muted" style="margin:4px 0 0">付いている読者・フォーム・シナリオ・ルール・条件をすべてまとめ先に付け替えて、このタグを消します。自動で作られた重複タグの整理に使います。</p></form>`
    : ""
}
<form method="post" action="/admin/tags/${h(t.id)}/delete" onsubmit="return confirm('タグ「${h(t.name)}」を削除しますか？（読者 ${t.total} 人から外れます。元に戻せません）')"><label>削除</label>
${
  blocked
    ? `<p class="muted" style="margin:0 0 8px">${icon("triangle-exclamation-point", 14)} 自動化のルール・ステップの条件・一斉配信の宛先で使っているため削除できません（消すと宛先や動きが変わるため）。先にそちらから外すか、統合を使ってください。</p>${usageLinks({ ...t.usage, forms: [], sequences: [] })}`
    : `<p class="muted" style="margin:0 0 8px">読者 ${t.total} 人から外れます。${detach.length ? `${h(detach.join("・"))}からも外します（そのフォーム・シナリオは残ります）。` : ""}</p><button type="submit" class="danger">${icon("trash", 14)}このタグを削除</button>`
}</form>`,
  });
}

export function registerTags(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/tags", async (c) => {
    const ctx = await getCtx();
    const rows = await listTagsWithUsage(ctx.db);
    const table = rows.length
      ? `<div class="wrap"><table class="tag-table"><tr><th>タグ</th><th>種類</th><th>付いている読者</th><th>うち配信中</th><th>使っている場所</th><th></th></tr>${rows
          .map(
            (r) => `<tr><td><span class="pill">${icon("tag", 12)}${h(r.name)}</span></td><td>${h(CATEGORY[r.category] ?? r.category)}</td><td>${r.total.toLocaleString("ja-JP")}</td><td>${r.active.toLocaleString("ja-JP")}</td>
<td class="use-cell">${usageLinks(r.usage)}</td><td><div class="tag-acts"><a href="/admin/readers?tag=${encodeURIComponent(r.name)}">読者を見る</a><button type="button" class="sub" data-dialog="tag-${h(r.id)}">${icon("pencil", 14)}管理</button></div></td></tr>`,
          )
          .join("")}</table></div>${rows.map((r) => tagDialog(r, rows)).join("")}`
      : emptyState({ icon: "tag", title: "まだタグがありません", text: "下で作るか、フォームから登録があるとフォームのタグが付きます。" });
    const body = `${pageHeader({
      title: "タグ",
      desc: "読者に付いているタグの一覧です。フォームやシナリオが自動で作ったタグも、「管理」から名前の変更・統合・削除ができます。",
      actions: `<button type="button" data-dialog="new-tag">${icon("plus", 16)}新しいタグ</button>`,
    })}
<style>
.use-cell{white-space:normal!important;min-width:220px}
.use-list{display:flex;flex-wrap:wrap;gap:var(--space-1)}
.use-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--line);border-radius:var(--radius-pill);font-size:12px;color:var(--ink);text-decoration:none;background:var(--surface)}
a.use-chip:hover{border-color:var(--accent)}
.tag-acts{display:flex;gap:var(--space-2);align-items:center;justify-content:flex-end}
dialog .copy-row{display:flex;gap:var(--space-2);align-items:center}dialog .copy-row input,dialog .copy-row select{flex:1}
dialog form+form{margin-top:var(--space-4);padding-top:var(--space-2);border-top:1px solid var(--line)}
</style>
${table}
${modal({
  id: "new-tag",
  title: "新しいタグ",
  body: `<form method="post" action="/admin/tags"><label>名前</label><input type="text" name="name" required maxlength="60"><p class="muted" style="margin:4px 0 0">作ったタグは、フォームの「登録した人に付けるタグ」やシナリオの完了タグ、読者の詳細画面で選べます。</p>
<div class="actions"><button type="button" class="sub" data-close>やめる</button><button type="submit">${icon("plus", 16)}作る</button></div></form>`,
})}`;
    return c.html(adminPage({ title: "タグ", active: "/admin/tags", body, flash: flashFrom(c) }));
  });

  app.post("/tags", async (c) => {
    const ctx = await getCtx();
    const r = await createTag(ctx, one(await readForm(c), "name"));
    if (!r.ok) return back(c, "/admin/tags", "err", r.error);
    await audit(ctx.db, "tag.create", r.id);
    return back(c, "/admin/tags", "ok", "タグを作りました");
  });

  app.post("/tags/:id/rename", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const r = await renameTag(ctx, id, one(await readForm(c), "name"));
    if (!r.ok) return back(c, "/admin/tags", "err", r.error);
    await audit(ctx.db, "tag.rename", id);
    return back(c, "/admin/tags", "ok", "名前を変えました（ルールや条件の名前も合わせて変えました）");
  });

  app.post("/tags/:id/merge", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const into = one(await readForm(c), "into");
    const r = await mergeTags(ctx, id, into);
    if (!r.ok) return back(c, "/admin/tags", "err", r.error);
    await audit(ctx.db, "tag.merge", id, { into });
    return back(c, "/admin/tags", "ok", "タグを統合しました");
  });

  app.post("/tags/:id/delete", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const r = await deleteTag(ctx, id);
    if (!r.ok) return back(c, "/admin/tags", "err", r.error);
    await audit(ctx.db, "tag.delete", id);
    return back(c, "/admin/tags", "ok", "タグを削除しました");
  });
}

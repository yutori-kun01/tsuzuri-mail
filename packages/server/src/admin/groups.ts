import { GROUP_KINDS, GROUP_NAME_MAX, groupItems, moveGroup, normalizeGroupName, type Group, type GroupKind } from "@tsuzuri/core";
import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { audit } from "./auth.js";
import { back, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { h } from "./ui.js";

/**
 * 一覧のグループ分け（シナリオ・フォーム）。見やすくするための整理で、配信の動きには関わらない。
 * グループを消しても中身は消えず「グループなし」に戻る。
 */

const TABLES: Record<GroupKind, string> = { sequence: "sequences", form: "forms" };
const LIST_PATH: Record<GroupKind, string> = { sequence: "/admin/sequences", form: "/admin/forms" };
const LABEL: Record<GroupKind, string> = { sequence: "シナリオ", form: "フォーム" };

const asKind = (v: string): GroupKind | undefined => GROUP_KINDS.find((k) => k === v);

export async function listGroups(ctx: AppContext, kind: GroupKind): Promise<Group[]> {
  return ctx.db.query<Group>("SELECT id, name, position FROM item_groups WHERE kind = $1 ORDER BY position, name", [kind]);
}

/** グループの選び方（作成フォームと一覧の行で使う） */
function groupOptions(groups: Group[], current: string | null): string {
  return `<option value="">グループなし</option>${groups.map((g) => `<option value="${h(g.id)}"${g.id === current ? " selected" : ""}>${h(g.name)}</option>`).join("")}`;
}

/** 作成フォームに入れるグループ欄（グループが無ければ出さない） */
export function groupField(groups: Group[]): string {
  return groups.length ? `<div><label>グループ</label><select name="group_id">${groupOptions(groups, null)}</select></div>` : "";
}

/** 一覧の行に置く「グループを移す」選択。選ぶとその場で保存する */
export function groupMover(kind: GroupKind, itemId: string, current: string | null, groups: Group[]): string {
  return `<form method="post" action="/admin/groups/assign" class="inline group-move"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="item_id" value="${h(itemId)}">
<select name="group_id" data-autosubmit aria-label="グループを移す">${groupOptions(groups, current)}</select><noscript><button type="submit" class="sub">移す</button></noscript></form>`;
}

/**
 * 項目をグループごとのカードに並べる。renderTable は 1 グループ分の行から表を作る。
 * グループが 1 つも無いときは、今までどおり表を 1 つだけ出す。見た目の CSS は groupManager が一緒に出す。
 */
export function groupedList<T extends { group_id: string | null }>(items: T[], groups: Group[], renderTable: (rows: T[]) => string): string {
  if (!groups.length) return items.length ? renderTable(items) : "";
  const sections = groupItems(items, groups);
  return `${sections
    .map(
      (s) => `<section class="group-card"><h2 class="group-head">${icon("folder", 16)}<span>${h(s.group?.name ?? "グループなし")}</span><span class="count">${s.items.length}</span></h2>
${s.items.length ? renderTable(s.items) : '<p class="muted group-empty">まだありません。各行の「グループ」から移せます。</p>'}</section>`,
    )
    .join("\n")}
<script>document.querySelectorAll('select[data-autosubmit]').forEach(function(s){s.addEventListener('change',function(){s.form.submit()})});</script>`;
}

const GROUP_STYLE = `<style>
.group-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);box-shadow:var(--shadow-card);margin-bottom:var(--space-4);overflow:hidden}
.group-head{display:flex;align-items:center;gap:var(--space-2);margin:0;padding:var(--space-3) var(--space-4);font-size:var(--text-body);border-bottom:1px solid var(--line);background:var(--surface-sunken)}
.group-head .count{color:var(--ink-muted);font-weight:400;font-size:var(--text-note)}
.group-card>.wrap{border:0;border-radius:0;box-shadow:none}
.group-card table{table-layout:fixed}.group-card th:first-child{width:28%}.group-card th.col-group{width:18%}.group-card td{overflow:hidden;text-overflow:ellipsis}
.group-empty{margin:0;padding:var(--space-4)}
.group-move{display:block}.group-move select{width:100%;min-width:0;padding:var(--space-1) var(--space-2);font-size:var(--text-note)}
.group-list{list-style:none;margin:0 0 var(--space-4);padding:0}
.group-list li{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) 0;border-bottom:1px solid var(--line)}
.group-list li form.rename{display:flex;gap:var(--space-2);flex:1}
.group-list li form.rename input{flex:1}
</style>`;

/** 「グループ管理」：追加・名前の変更・並べ替え・削除 */
export function groupManager(kind: GroupKind, groups: Group[]): string {
  const rows = groups
    .map(
      (g, i) => `<li><form method="post" action="/admin/groups/${h(g.id)}/rename" class="rename"><input type="text" name="name" value="${h(g.name)}" required maxlength="${GROUP_NAME_MAX}" aria-label="グループ名"><button type="submit" class="sub">${icon("pencil", 14)}名前を保存</button></form>
<form method="post" action="/admin/groups/${h(g.id)}/move" class="inline"><input type="hidden" name="dir" value="up"><button type="submit" class="sub icon-only" title="上へ" aria-label="上へ"${i === 0 ? " disabled" : ""}>${icon("arrow-up", 14)}</button></form>
<form method="post" action="/admin/groups/${h(g.id)}/move" class="inline"><input type="hidden" name="dir" value="down"><button type="submit" class="sub icon-only" title="下へ" aria-label="下へ"${i === groups.length - 1 ? " disabled" : ""}>${icon("arrow-down", 14)}</button></form>
<form method="post" action="/admin/groups/${h(g.id)}/delete" class="inline" onsubmit="return confirm('グループ「${h(g.name)}」を削除しますか？（中の${LABEL[kind]}は消えず、グループなしに戻ります）')"><button type="submit" class="sub icon-only" title="削除" aria-label="削除">${icon("trash", 14)}</button></form></li>`,
    )
    .join("");
  return `${GROUP_STYLE}<details class="card add-step" id="groups"><summary>${icon("folder", 16)}グループ管理${groups.length ? `（${groups.length}）` : ""}</summary>
<p class="muted" style="margin-top:0">${LABEL[kind]}を「商品受け渡し」「ステップ」のようにまとめて、一覧を見やすくします。配信の動きには影響しません。グループを消しても中の${LABEL[kind]}は消えません。</p>
${groups.length ? `<ul class="group-list">${rows}</ul>` : ""}
<form method="post" action="/admin/groups" class="row" style="align-items:flex-end"><input type="hidden" name="kind" value="${kind}">
<div><label>新しいグループの名前</label><input type="text" name="name" required maxlength="${GROUP_NAME_MAX}"></div>
<div style="flex:0"><button type="submit">${icon("plus", 16)}追加</button></div></form></details>`;
}

/** 送られてきた group_id が、その種類のグループとして実在するか（空ならグループなし） */
export async function resolveGroupId(ctx: AppContext, kind: GroupKind, v: string): Promise<string | null | undefined> {
  if (!v) return null;
  const [g] = await ctx.db.query<{ id: string }>("SELECT id FROM item_groups WHERE id::text = $1 AND kind = $2", [v, kind]);
  return g?.id;
}

async function groupKindOf(ctx: AppContext, id: string): Promise<GroupKind | undefined> {
  const [g] = await ctx.db.query<{ kind: string }>("SELECT kind FROM item_groups WHERE id::text = $1", [id]);
  return g ? asKind(g.kind) : undefined;
}

export function registerGroups(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.post("/groups", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const kind = asKind(one(f, "kind"));
    if (!kind) return back(c, "/admin", "err", "種類が正しくありません");
    const name = normalizeGroupName(one(f, "name"));
    if (!name) return back(c, LIST_PATH[kind], "err", `グループ名は 1〜${GROUP_NAME_MAX} 文字にしてください`);
    const rows = await ctx.db.query<{ id: string }>(
      `INSERT INTO item_groups (kind, name, position)
       VALUES ($1, $2, (SELECT coalesce(max(position), 0) + 1 FROM item_groups WHERE kind = $1))
       ON CONFLICT (kind, name) DO NOTHING RETURNING id`,
      [kind, name],
    );
    if (!rows[0]) return back(c, LIST_PATH[kind], "err", "同じ名前のグループがあります");
    await audit(ctx.db, "group.create", rows[0].id, { kind });
    return back(c, LIST_PATH[kind], "ok", `グループ「${name}」を作りました。各行の「グループ」から${LABEL[kind]}を移せます`);
  });

  app.post("/groups/assign", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const kind = asKind(one(f, "kind"));
    if (!kind) return back(c, "/admin", "err", "種類が正しくありません");
    const groupId = await resolveGroupId(ctx, kind, one(f, "group_id"));
    if (groupId === undefined) return back(c, LIST_PATH[kind], "err", "グループが見つかりません");
    const rows = await ctx.db.query(`UPDATE ${TABLES[kind]} SET group_id = $2 WHERE id::text = $1 RETURNING id`, [one(f, "item_id"), groupId]);
    if (rows.length === 0) return back(c, LIST_PATH[kind], "err", `${LABEL[kind]}が見つかりません`);
    await audit(ctx.db, "group.assign", one(f, "item_id"), { kind, group: groupId });
    return back(c, LIST_PATH[kind], "ok", "グループを移しました");
  });

  app.post("/groups/:id/rename", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const kind = await groupKindOf(ctx, id);
    if (!kind) return back(c, "/admin", "err", "グループが見つかりません");
    const name = normalizeGroupName(one(await readForm(c), "name"));
    if (!name) return back(c, LIST_PATH[kind], "err", `グループ名は 1〜${GROUP_NAME_MAX} 文字にしてください`);
    const dup = await ctx.db.query("SELECT 1 FROM item_groups WHERE kind = $1 AND name = $2 AND id::text <> $3", [kind, name, id]);
    if (dup.length) return back(c, LIST_PATH[kind], "err", "同じ名前のグループがあります");
    await ctx.db.query("UPDATE item_groups SET name = $2 WHERE id::text = $1", [id, name]);
    await audit(ctx.db, "group.rename", id);
    return back(c, LIST_PATH[kind], "ok", "グループ名を変えました");
  });

  app.post("/groups/:id/move", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const kind = await groupKindOf(ctx, id);
    if (!kind) return back(c, "/admin", "err", "グループが見つかりません");
    const dir = one(await readForm(c), "dir") === "up" ? -1 : 1;
    const order = moveGroup(await listGroups(ctx, kind), id, dir);
    await ctx.db.transaction(async (tx) => {
      for (const [i, gid] of order.entries()) await tx.query("UPDATE item_groups SET position = $2 WHERE id = $1", [gid, i + 1]);
    });
    await audit(ctx.db, "group.move", id);
    return back(c, LIST_PATH[kind], "ok", "並べ替えました");
  });

  app.post("/groups/:id/delete", async (c) => {
    const ctx = await getCtx();
    const id = c.req.param("id");
    const kind = await groupKindOf(ctx, id);
    if (!kind) return back(c, "/admin", "err", "グループが見つかりません");
    await ctx.db.query("DELETE FROM item_groups WHERE id::text = $1", [id]);
    await audit(ctx.db, "group.delete", id);
    return back(c, LIST_PATH[kind], "ok", `グループを削除しました（中の${LABEL[kind]}はグループなしに戻りました）`);
  });
}

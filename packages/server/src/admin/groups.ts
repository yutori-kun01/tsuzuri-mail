import { GROUP_KINDS, GROUP_NAME_MAX, groupItems, normalizeGroupName, parseLayout, type Group, type GroupKind } from "@tsuzuri/core";
import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { audit } from "./auth.js";
import { back, many, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { h } from "./ui.js";

/**
 * 一覧のグループ分けとドラッグでの並べ替え（シナリオ・フォーム）。見やすくするための整理で、配信の動きには関わらない。
 * グループを消しても中身は消えず「グループなし」に戻る。
 */

const TABLES: Record<GroupKind, string> = { sequence: "sequences", form: "forms" };
const LIST_PATH: Record<GroupKind, string> = { sequence: "/admin/sequences", form: "/admin/forms" };
const LABEL: Record<GroupKind, string> = { sequence: "シナリオ", form: "フォーム" };

const asKind = (v: string): GroupKind | undefined => GROUP_KINDS.find((k) => k === v);

export async function listGroups(ctx: AppContext, kind: GroupKind): Promise<Group[]> {
  return ctx.db.query<Group>("SELECT id, name, position FROM item_groups WHERE kind = $1 ORDER BY position, name", [kind]);
}

/** 作成フォームに入れるグループ欄（グループが無ければ出さない） */
export function groupField(groups: Group[]): string {
  return groups.length
    ? `<div><label>グループ</label><select name="group_id"><option value="">グループなし</option>${groups.map((g) => `<option value="${h(g.id)}">${h(g.name)}</option>`).join("")}</select></div>`
    : "";
}

/** 「グループを作る」アコーディオン。作ると、そのグループの位置へ移動して目立たせる */
export function groupCreator(kind: GroupKind): string {
  return `${GROUP_STYLE}<details class="card add-step" id="new-group"><summary>${icon("folder", 16)}グループを作る</summary>
<form method="post" action="/admin/groups" class="row" style="align-items:flex-end"><input type="hidden" name="kind" value="${kind}">
<div><label>グループ名（例：商品受け渡し、ステップ）</label><input type="text" name="name" required maxlength="${GROUP_NAME_MAX}"></div>
<div style="flex:0"><button type="submit">${icon("plus", 16)}作る</button></div></form>
<p class="muted" style="margin-bottom:0">${LABEL[kind]}をまとめて一覧を見やすくします（配信の動きには影響しません）。行の左の ${icon("grip-vertical", 14)} をドラッグすると、並べ替えたり別のグループへ移したりできます。</p></details>`;
}

export interface GroupedListOptions<T> {
  kind: GroupKind;
  items: T[];
  groups: Group[];
  /** 見出しの <th> たち（つまみの列は自動で足す） */
  head: string;
  /** 1 行分の <td> たち（つまみの列は自動で足す） */
  row: (item: T) => string;
}

/**
 * 項目を一覧にする。グループがあればグループごとのカード、無ければ表 1 つ。
 * どちらも行の左のつまみでドラッグして並べ替えられ、並びはその場で保存する。
 */
export function groupedList<T extends { id: string; group_id: string | null }>(o: GroupedListOptions<T>): string {
  if (!o.items.length && !o.groups.length) return "";
  const cols = (o.head.match(/<th[\s>]/g) ?? []).length + 1;
  const table = (rows: T[], group: string) => `<div class="wrap"><table class="grouped-table"><thead><tr><th class="col-grip"><span class="sr">並べ替え</span></th>${o.head}</tr></thead>
<tbody data-group="${h(group)}">${rows
    .map((r) => `<tr data-id="${h(r.id)}"><td class="grip" draggable="true" title="ドラッグで並べ替え・グループを移す">${icon("grip-vertical", 16)}</td>${o.row(r)}</tr>`)
    .join("")}<tr class="drop-hint"${rows.length ? " hidden" : ""}><td colspan="${cols}">ここへドラッグして入れられます</td></tr></tbody></table></div>`;
  const sections = groupItems(o.items, o.groups);
  const inner = sections.length
    ? sections
        .map((s) => {
          const g = s.group;
          const actions = g
            ? `<div class="group-actions"><details class="group-rename"><summary title="名前を変える" aria-label="名前を変える">${icon("pencil", 14)}</summary>
<form method="post" action="/admin/groups/${h(g.id)}/rename"><input type="text" name="name" value="${h(g.name)}" required maxlength="${GROUP_NAME_MAX}" aria-label="グループ名"><button type="submit">保存</button></form></details>
<form method="post" action="/admin/groups/${h(g.id)}/delete" class="inline" onsubmit="return confirm('グループ「${h(g.name)}」を削除しますか？（中の${LABEL[o.kind]}は消えず、グループなしに戻ります）')"><button type="submit" class="sub icon-only" title="グループを削除" aria-label="グループを削除">${icon("trash", 14)}</button></form></div>`
            : "";
          return `<section class="group-card" id="g-${g ? h(g.id) : "none"}"${g ? ` data-gid="${h(g.id)}"` : ""}><div class="group-head">${g ? `<span class="ghandle" draggable="true" title="ドラッグでグループを並べ替え">${icon("grip-vertical", 16)}</span>` : ""}${icon("folder", 16)}<h2>${h(g?.name ?? "グループなし")}</h2><span class="count">${s.items.length}</span>${actions}</div>
${table(s.items, g?.id ?? "")}</section>`;
        })
        .join("\n")
    : table(o.items, "");
  return `<p id="order-status" class="muted order-status" aria-live="polite"></p><div id="grouped" data-kind="${o.kind}">${inner}</div>${DRAG_SCRIPT}`;
}

const GROUP_STYLE = `<style>
.group-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);box-shadow:var(--shadow-card);margin-bottom:var(--space-4);overflow:hidden;scroll-margin-top:var(--space-6)}
.group-card:target{border-color:var(--accent);box-shadow:var(--shadow-focus)}
.group-head{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line);background:var(--surface-sunken)}
.group-head h2{margin:0;font-size:var(--text-body)}
.group-head .count{color:var(--ink-muted);font-size:var(--text-note)}
.group-actions{margin-left:auto;display:flex;align-items:center;gap:var(--space-2)}
.group-rename{position:relative}
.group-actions button.icon-only{width:32px;height:32px;padding:0}
.group-rename>summary{list-style:none;display:grid;place-items:center;width:32px;height:32px;box-sizing:border-box;margin:0;border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--ink-muted);background:var(--surface)}
.group-rename>summary::-webkit-details-marker{display:none}
.group-rename form{position:absolute;right:0;top:calc(100% + var(--space-1));z-index:5;display:flex;gap:var(--space-2);padding:var(--space-2);width:320px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow-card)}
.group-rename input{flex:1}
.ghandle,.grip{cursor:grab;color:var(--ink-muted)}
.ghandle{display:grid;place-items:center}
.group-card>.wrap{border:0;border-radius:0;box-shadow:none}
.grouped-table{table-layout:fixed}.grouped-table th.col-grip{width:36px}.grouped-table th:nth-child(2){width:28%}.grouped-table th.col-act{width:156px}
.grouped-table th.col-wide{width:18%}
.grouped-table th,.wrap .grouped-table td{white-space:normal;overflow-wrap:anywhere;vertical-align:middle}
.grouped-table td.grip{padding-right:0}
.drop-hint td{color:var(--ink-muted);text-align:center;font-size:var(--text-note)}
.dragging{opacity:.45}
.order-status{margin:0 0 var(--space-2)}.order-status:empty{display:none}
#new-group{padding:var(--space-3) var(--space-4)}#new-group>summary{margin:0;font-size:var(--text-note)}#new-group[open]>summary{margin-bottom:var(--space-3)}#new-group form{margin:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style>`;

/** ドラッグで行・グループを並べ替え、終わったら並び全体を保存する */
const DRAG_SCRIPT = `<script>(function(){
var root=document.getElementById('grouped');if(!root)return;var st=document.getElementById('order-status');var drag=null,type=null,before='';
function state(){var p=new URLSearchParams();p.append('kind',root.dataset.kind);root.querySelectorAll('[data-gid]').forEach(function(c){p.append('groups',c.dataset.gid)});root.querySelectorAll('tbody[data-group]').forEach(function(tb){tb.querySelectorAll('tr[data-id]').forEach(function(tr){p.append('items',tr.dataset.id+':'+tb.dataset.group)})});return p}
function refresh(){root.querySelectorAll('tbody[data-group]').forEach(function(tb){var n=tb.querySelectorAll('tr[data-id]').length;var hint=tb.querySelector('.drop-hint');if(hint)hint.hidden=n>0;var card=tb.closest('.group-card');var cnt=card&&card.querySelector('.count');if(cnt)cnt.textContent=n})}
root.addEventListener('dragstart',function(e){var t=e.target;if(!t.closest)return;if(t.closest('.grip')){drag=t.closest('tr');type='row'}else if(t.closest('.ghandle')){drag=t.closest('[data-gid]');type='group'}else return;before=state().toString();drag.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain','');e.dataTransfer.setDragImage(drag,20,20)}catch(_){}});
root.addEventListener('dragover',function(e){if(!drag||!e.target.closest)return;
if(type==='row'){var tb=e.target.closest('tbody[data-group]');if(!tb)return;e.preventDefault();var tr=e.target.closest('tr[data-id]');if(tr===drag)return;if(tr){var r=tr.getBoundingClientRect();tb.insertBefore(drag,(e.clientY-r.top)>r.height/2?tr.nextSibling:tr)}else{tb.insertBefore(drag,tb.querySelector('.drop-hint'))}refresh()}
else{var c=e.target.closest('[data-gid]');if(!c||c===drag)return;e.preventDefault();var r2=c.getBoundingClientRect();root.insertBefore(drag,(e.clientY-r2.top)>r2.height/2?c.nextSibling:c)}});
root.addEventListener('drop',function(e){if(drag)e.preventDefault()});
root.addEventListener('dragend',function(){if(!drag)return;drag.classList.remove('dragging');drag=null;var p=state();if(p.toString()===before)return;st.textContent='保存しています…';
fetch('/admin/groups/order',{method:'POST',body:p,credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error();st.textContent='並びを保存しました'}).catch(function(){st.textContent='保存できませんでした。ページを読み込み直します';setTimeout(function(){location.reload()},1500)})});
})();</script>`;

/** 送られてきた group_id が、その種類のグループとして実在するか（空ならグループなし、無ければ undefined） */
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
    // できたグループの位置へ飛ばす（#g-… がページ内の印になる）
    const text = `グループ「${name}」を作りました。${LABEL[kind]}をドラッグして入れてください`;
    return c.redirect(`${LIST_PATH[kind]}?ok=${encodeURIComponent(text)}#g-${rows[0].id}`, 303);
  });

  /** ドラッグ後の並び全体（グループの順、項目の順と所属）を保存する。画面の fetch から呼ぶ */
  app.post("/groups/order", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const kind = asKind(one(f, "kind"));
    if (!kind) return c.json({ error: "kind" }, 400);
    const groups = await listGroups(ctx, kind);
    const items = await ctx.db.query<{ id: string }>(`SELECT id FROM ${TABLES[kind]}`);
    const layout = parseLayout(many(f, "groups"), many(f, "items"), { groups: new Set(groups.map((g) => g.id)), items: new Set(items.map((r) => r.id)) });
    if (!layout) return c.json({ error: "layout" }, 400);
    await ctx.db.transaction(async (tx) => {
      for (const [i, gid] of layout.groups.entries()) await tx.query("UPDATE item_groups SET position = $2 WHERE id = $1", [gid, i + 1]);
      for (const [i, it] of layout.items.entries()) await tx.query(`UPDATE ${TABLES[kind]} SET group_id = $2, list_position = $3 WHERE id = $1`, [it.id, it.group, i + 1]);
    });
    await audit(ctx.db, "group.order", undefined, { kind });
    return c.json({ ok: true });
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

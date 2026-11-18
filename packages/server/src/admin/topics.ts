import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { audit } from "./auth.js";
import { back, flashFrom, one, readForm } from "./common.js";
import { icon } from "./icons.js";
import { adminPage, h, pageHeader } from "./ui.js";

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** 配信の種類（読者が配信設定ページで選べるもの） */
export function registerTopics(app: Hono, getCtx: () => Promise<AppContext>): void {
  app.get("/topics", async (c) => {
    const ctx = await getCtx();
    const rows = await ctx.db.query<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      default_subscribed: boolean;
      visible: boolean;
      position: number;
      opted_in: number;
      opted_out: number;
      broadcasts: number;
      sequences: number;
    }>(
      `SELECT t.*,
              (SELECT count(*) FROM contact_topic_prefs p WHERE p.topic_id = t.id AND p.subscribed)::int AS opted_in,
              (SELECT count(*) FROM contact_topic_prefs p WHERE p.topic_id = t.id AND NOT p.subscribed)::int AS opted_out,
              (SELECT count(*) FROM broadcasts b WHERE b.topic_id = t.id)::int AS broadcasts,
              (SELECT count(*) FROM sequences s WHERE s.topic_id = t.id)::int AS sequences
         FROM topics t ORDER BY t.position, t.created_at`,
    );
    const editRow = (t?: (typeof rows)[number]) => `<form method="post" action="${t ? `/admin/topics/${h(t.id)}` : "/admin/topics"}" class="card">
<div class="row"><div><label>名前（読者に見える）</label><input type="text" name="name" value="${h(t?.name)}" required maxlength="60"></div>
${t ? "" : `<div><label>識別名（任意。英小文字・数字・ハイフン。空なら自動）</label><input type="text" name="slug" pattern="[a-z0-9][a-z0-9-]{1,40}"></div>`}
<div><label>並び順</label><input type="number" name="position" value="${h(t?.position ?? 0)}"></div></div>
<label>説明（読者に見える。任意）</label><input type="text" name="description" value="${h(t?.description)}" maxlength="120">
<div class="checks">
<label class="check"><input type="checkbox" name="default_subscribed" value="1"${(t?.default_subscribed ?? true) ? " checked" : ""}>最初から受け取る設定にする（外すと「受け取る」を選んだ人にだけ届く）</label>
<label class="check"><input type="checkbox" name="visible" value="1"${(t?.visible ?? true) ? " checked" : ""}>配信設定ページに表示する</label></div>
<div class="actions"><button type="submit">${t ? "保存する" : "追加する"}</button></div></form>`;
    const preset = (name: string, desc: string, def: boolean, slug: string) =>
      rows.some((r) => r.slug === slug)
        ? ""
        : `<form method="post" action="/admin/topics" class="inline"><input type="hidden" name="slug" value="${slug}"><input type="hidden" name="name" value="${h(name)}"><input type="hidden" name="description" value="${h(desc)}"><input type="hidden" name="visible" value="1">${def ? '<input type="hidden" name="default_subscribed" value="1">' : ""}<input type="hidden" name="position" value="${rows.length}">
<button class="sub" type="submit">${icon("plus", 16)}${h(name)}</button></form>`;
    const presets = [
      preset("メルマガ本誌", "定期的にお届けする本誌", true, "main"),
      preset("お知らせ・キャンペーン", "講座や商品の案内、キャンペーン", true, "news"),
      preset("イベント・セミナーの案内", "開催のお知らせ", false, "events"),
    ].join("");
    const body = `${pageHeader({ title: "配信の種類", desc: "メールを「本誌」「お知らせ」のように分けておくと、読者が受け取りたい種類だけを選べます（全部止めるより、配信停止が減ります）。" })}
<section class="card"><h2 class="with-icon">${icon("info", 16)}使い方は 2 つだけ</h2>
<ol class="muted" style="margin:0;padding-left:1.2em;line-height:1.9">
<li>ここで種類を作る（下のボタンで、よくある種類をすぐ追加できます）</li>
<li>一斉配信やシナリオを作るときに、カードで種類を選ぶ（選ばなければ、配信中の全員に届きます）</li></ol>
${presets ? `<div class="actions">${presets}</div>` : ""}</section>
<div class="wrap"><table><tr><th>名前</th><th>最初の設定</th><th>表示</th><th>受け取るを選んだ人</th><th>受け取らないを選んだ人</th><th>使っている配信</th><th></th></tr>
${rows
  .map(
    (t) => `<tr><td><b>${h(t.name)}</b><div class="muted">${h(t.description)}</div></td><td>${t.default_subscribed ? "受け取る" : "受け取らない"}</td>
<td>${t.visible ? "表示" : '<span class="muted">非表示</span>'}</td><td>${t.opted_in}</td><td>${t.opted_out}</td><td>一斉配信 ${t.broadcasts}・シナリオ ${t.sequences}</td>
<td><form method="post" action="/admin/topics/${h(t.id)}/delete" onsubmit="return confirm('削除しますか？この種類を設定した配信は「種類なし」になります')"><button class="danger" type="submit">削除</button></form></td></tr>`,
  )
  .join("") || '<tr><td colspan="7" class="muted">まだありません（例：「メルマガ本誌」「キャンペーン・お知らせ」）</td></tr>'}</table></div>
${rows.map((t) => `<h2>${h(t.name)} を編集</h2>${editRow(t)}`).join("")}
<h2>新しい種類</h2>${editRow()}`;
    return c.html(adminPage({ title: "配信の種類", active: "/admin/topics", body, flash: flashFrom(c) }));
  });

  const values = (f: Awaited<ReturnType<typeof readForm>>) => ({
    name: one(f, "name"),
    description: one(f, "description") || null,
    position: Number(one(f, "position")) || 0,
    default_subscribed: one(f, "default_subscribed") === "1",
    visible: one(f, "visible") === "1",
  });

  app.post("/topics", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const slug = one(f, "slug") || `t-${Date.now().toString(36)}`;
    const v = values(f);
    if (!SLUG.test(slug) || !v.name) return back(c, "/admin/topics", "err", "名前と識別名（英小文字・数字・ハイフン）を入力してください");
    const rows = await ctx.db.query<{ id: string }>(
      `INSERT INTO topics (slug, name, description, position, default_subscribed, visible) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [slug, v.name, v.description, v.position, v.default_subscribed, v.visible],
    );
    if (!rows[0]) return back(c, "/admin/topics", "err", "同じ識別名の種類があります");
    await audit(ctx.db, "topic.create", rows[0].id);
    return back(c, "/admin/topics", "ok", `「${v.name}」を追加しました`);
  });

  app.post("/topics/:id", async (c) => {
    const ctx = await getCtx();
    const v = values(await readForm(c));
    if (!v.name) return back(c, "/admin/topics", "err", "名前を入力してください");
    await ctx.db.query(
      "UPDATE topics SET name = $2, description = $3, position = $4, default_subscribed = $5, visible = $6 WHERE id::text = $1",
      [c.req.param("id"), v.name, v.description, v.position, v.default_subscribed, v.visible],
    );
    await audit(ctx.db, "topic.update", c.req.param("id"));
    return back(c, "/admin/topics", "ok", "保存しました");
  });

  app.post("/topics/:id/delete", async (c) => {
    const ctx = await getCtx();
    await ctx.db.query("DELETE FROM topics WHERE id::text = $1", [c.req.param("id")]);
    await audit(ctx.db, "topic.delete", c.req.param("id"));
    return back(c, "/admin/topics", "ok", "削除しました");
  });
}

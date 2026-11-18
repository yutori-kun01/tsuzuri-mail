import type { Hono } from "hono";
import type { AppContext } from "../context.js";
import { decodeCsv, importContacts, splitTags, type ImportReport } from "../services/import.js";
import { addContactManually, inviteByForm } from "../services/readers.js";
import { audit } from "./auth.js";
import { back, flashFrom, list, one, readForm, tagsFrom, tagsWithCounts } from "./common.js";
import { icon } from "./icons.js";
import type { AdminOptions } from "./index.js";
import { adminPage, emptyState, fromJstInput, h, kpiCard, linkButton, pageHeader, tabs, tagPicker } from "./ui.js";

/** CSV の上限（1 万人分の一覧でも十分な大きさ） */
const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** 同意の取り方の書き方の例（入力欄の候補） */
const EVIDENCE_EXAMPLES = [
  "以前のメール配信サービスから移行（登録時に配信に同意済み）",
  "セミナー・イベントの申込フォームで配信に同意",
  "名刺交換の際に配信を案内し、口頭で同意",
  "問い合わせの際に、配信を希望された",
];

const LEGAL_NOTE =
  "特定電子メール法により、メールマガジンは同意を得た人にだけ送れます。どのように同意を得たかを記録として残します（読者の詳細画面の「同意の記録」に表示されます）。";

function evidenceField(required: boolean): string {
  // 1 人ずつの画面では「確認メールを送る」を選んだときは不要なので、必須かどうかはサーバー側で確かめる
  return `<label for="evidence">どのように同意を得たか（必須）</label>
<input id="evidence" type="text" name="evidence"${required ? " required" : ""} maxlength="200" list="evidence-examples" placeholder="例：${h(EVIDENCE_EXAMPLES[0])}">
<datalist id="evidence-examples">${EVIDENCE_EXAMPLES.map((e) => `<option value="${h(e)}"></option>`).join("")}</datalist>`;
}

function addTabs(current: "manual" | "csv"): string {
  return tabs([
    { href: "/admin/readers/new", label: "1 人ずつ追加", current: current === "manual" },
    { href: "/admin/readers/new?tab=csv", label: "CSV で取り込む", current: current === "csv" },
  ]);
}

const RESULT_LABEL: Record<string, string> = {
  add: '<span class="pill good">追加</span>',
  exists: '<span class="pill">登録済み</span>',
  duplicate: '<span class="pill warn">重複</span>',
  invalid: '<span class="pill bad">不正</span>',
};

function reportTable(r: ImportReport, limit: number): string {
  // 問題のある行を先に、追加される行は先頭の数件だけ見せる
  const problems = r.rows.filter((x) => x.result !== "add");
  const adds = r.rows.filter((x) => x.result === "add");
  const shown = [...problems.slice(0, limit), ...adds.slice(0, Math.max(10, limit - problems.length))];
  if (!shown.length) return "";
  const more = r.rows.length - shown.length;
  return `<div class="wrap"><table><tr><th>行</th><th>メールアドレス</th><th>名前</th><th>タグ</th><th>結果</th><th>理由</th></tr>${shown
    .map(
      (x) => `<tr><td>${x.line}</td><td>${h(x.email)}</td><td>${h(x.name)}</td><td>${x.tags.map((t) => `<span class="pill">${h(t)}</span>`).join("")}</td>
<td>${RESULT_LABEL[x.result] ?? ""}</td><td class="muted">${h(x.reason)}</td></tr>`,
    )
    .join("")}</table></div>${more > 0 ? `<p class="muted" style="margin-top:8px">ほか ${more} 行（追加される行）は省略しています。</p>` : ""}`;
}

function summary(r: ImportReport, done: boolean): string {
  return `<div class="kpis">
${kpiCard({ label: done ? "追加した読者" : "追加される読者", value: String(r.imported), icon: "user-plus", tone: "good" })}
${kpiCard({ label: "既に登録済み（変えない）", value: String(r.skippedExisting), icon: "users" })}
${kpiCard({ label: "ファイル内の重複", value: String(r.duplicates), icon: "copy", ...(r.duplicates ? { tone: "warn" as const } : {}) })}
${kpiCard({ label: "読めなかった行", value: String(r.invalid.length), icon: "circle-x", ...(r.invalid.length ? { tone: "bad" as const } : {}) })}
</div>`;
}

export function registerReaderAdd(app: Hono, getCtx: () => Promise<AppContext>, opts: AdminOptions): void {
  app.get("/readers/new", async (c) => {
    const ctx = await getCtx();
    const tab = c.req.query("tab") === "csv" ? "csv" : "manual";
    const forms = await ctx.db.query<{ id: string; name: string; active: boolean }>("SELECT id, name, active FROM forms ORDER BY created_at");
    const seqs = await ctx.db.query<{ id: string; name: string }>(
      "SELECT id, name FROM sequences WHERE status = 'active' AND purpose = 'normal' ORDER BY created_at",
    );
    const allTags = await tagsWithCounts(ctx);
    const seqSelect = `<label for="sequence_id">登録後に始めるシナリオ（任意）</label><select id="sequence_id" name="sequence_id"><option value="">始めない</option>${seqs
      .map((s) => `<option value="${h(s.id)}">${h(s.name)}</option>`)
      .join("")}</select>`;

    const manual = `<div class="split"><div>
<form method="post" action="/admin/readers/new" class="card">
<div class="row"><div><label for="email">メールアドレス（必須）</label><input id="email" type="email" name="email" required maxlength="254" autocomplete="off"></div>
<div><label for="name">名前（任意。%name% に入ります）</label><input id="name" type="text" name="name" maxlength="40" autocomplete="off"></div></div>
<h2>登録のしかた</h2>
<label class="check"><input type="radio" name="mode" value="invite" checked${forms.length ? "" : " disabled"}>本人に確認メールを送る（おすすめ）</label>
<div style="margin:4px 0 12px 24px">
<p class="muted" style="margin:0">本人がメールのリンクを押すと登録が完了します。選んだフォームの確認メール・タグ・特典・シナリオがそのまま使われます。</p>
${forms.length ? `<select name="form_id" aria-label="使うフォーム">${forms.map((f) => `<option value="${h(f.id)}">${h(f.name)}${f.active ? "" : "（受付停止中）"}</option>`).join("")}</select>` : `<p class="muted">フォームがまだ無いため選べません。<a href="/admin/forms">フォームを作る</a></p>`}
</div>
<label class="check"><input type="radio" name="mode" value="direct"${forms.length ? "" : " checked"}>同意済みとして、すぐ配信中にする</label>
<div style="margin:4px 0 0 24px">
<p class="muted" style="margin:0">紙の申込書や対面などで、すでに配信の同意を得ている人のときだけ使います。確認メールは送りません。</p>
${evidenceField(false)}
<label for="consented_at">同意した日時（任意。空なら今）</label><input id="consented_at" type="datetime-local" name="consented_at">
<label>付けるタグ（任意。押して選ぶか、新しく入力）</label>
${tagPicker({ name: "tags", tags: allTags, selected: [], allowNew: "newTags" })}
${seqSelect}
</div>
<div class="actions"><button type="submit">${icon("user-plus", 16)}追加する</button><a class="btn sub" href="/admin/readers">やめる</a></div>
</form></div>
<aside class="card"><h2 class="with-icon">${icon("info", 16)}大切なこと</h2><p class="muted" style="margin:0 0 8px">${h(LEGAL_NOTE)}</p>
<p class="muted" style="margin:0">配信停止・苦情・不達になった人は、ここからは戻せません（本人がフォームから登録し直すことはできます）。</p></aside></div>`;

    const csv = `<div class="split"><div>
<form method="post" action="/admin/readers/import/preview" class="card" enctype="multipart/form-data">
<label for="file">CSV ファイル（UTF-8 または Excel の CSV（Shift_JIS）、5MB まで）</label><input id="file" type="file" name="file" accept=".csv,text/csv">
<label for="csv">またはここに貼り付け</label><textarea id="csv" name="csv" style="min-height:160px" placeholder="email,name&#10;yamada@example.com,山田"></textarea>
<div class="row"><div><label for="label">取り込み元の名前（必須。この名前のタグが付きます）</label><input id="label" type="text" name="label" required maxlength="40" placeholder="例：old-newsletter"></div>
<div><label for="tags">全員に付けるタグ（任意。カンマ区切り）</label><input id="tags" type="text" name="tags"></div></div>
${evidenceField(true)}
<div class="actions"><button type="submit">${icon("eye", 16)}内容を確認する</button><a class="btn sub" href="/admin/readers">やめる</a></div>
<p class="muted" style="margin-top:8px">次の画面で、追加される人数と読めない行を確認してから取り込みます。この時点ではまだ何も登録されません。</p>
</form></div>
<aside class="card"><h2 class="with-icon">${icon("info", 16)}CSV の書き方</h2>
<p class="muted" style="margin:0 0 8px">1 行目は見出し。使える列（日本語の見出しでも可）：</p>
<ul class="muted" style="margin:0 0 8px;padding-left:1.2em">
<li><code>email</code>／メールアドレス（必須）</li>
<li><code>name</code>／名前</li>
<li><code>consented_at</code>／登録日（例：2025-04-01）</li>
<li><code>tags</code>／タグ（複数は「;」で区切る）</li>
<li><code>attr.○○</code>（読者ごとの項目）</li></ul>
<p class="muted" style="margin:0 0 8px">既に登録されているアドレスは変更しません（配信停止した人を勝手に戻さないため）。取り込んだ人は確認メールなしで配信中になります。</p>
<p class="muted" style="margin:0">${h(LEGAL_NOTE)}</p></aside></div>`;

    const body = `${pageHeader({ title: "読者を追加", desc: "1 人ずつ追加するか、CSV でまとめて取り込みます。", back: ["/admin/readers", "読者"] })}
${addTabs(tab)}${tab === "csv" ? csv : manual}`;
    return c.html(adminPage({ title: "読者を追加", active: "/admin/readers", body, flash: flashFrom(c) }));
  });

  app.post("/readers/new", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    const email = one(f, "email");
    const name = one(f, "name");
    if (one(f, "mode") === "invite") {
      const r = await inviteByForm(ctx, one(f, "form_id"), email, name || undefined);
      if (r.status === "invalid-email") return back(c, "/admin/readers/new", "err", "メールアドレスの形式が正しくありません");
      if (r.status === "form-not-found") return back(c, "/admin/readers/new", "err", "フォームが見つかりません");
      if (r.status === "blocked") return back(c, "/admin/readers/new", "err", `確認メールは送りませんでした：${r.reason}`);
      if (r.status === "throttled") return back(c, "/admin/readers/new", "err", "このアドレスには 24 時間以内に確認メールを何度も送っています。時間をおいてください");
      await audit(ctx.db, "reader.invite", r.contactId);
      if (r.status === "already-active") return back(c, `/admin/readers/${r.contactId}`, "ok", "既に配信中の読者でした。フォームのタグとシナリオを付けました");
      // 招待は常に確認メールで確かめる（requireConfirmation）ので、ここで登録完了になることはない
      if (r.status === "subscribed") return back(c, `/admin/readers/${r.contactId}`, "ok", "登録しました");
      await opts.enqueue([r.messageId]);
      return back(c, `/admin/readers/${r.contactId}`, "ok", "確認メールの送信を受け付けました。本人がリンクを押すと登録が完了します（送信の状態は配信ログで確認できます）");
    }
    const evidence = one(f, "evidence");
    if (!evidence) return back(c, "/admin/readers/new", "err", "どのように同意を得たかを書いてください");
    const at = one(f, "consented_at") ? fromJstInput(one(f, "consented_at")) : undefined;
    if (one(f, "consented_at") && !at) return back(c, "/admin/readers/new", "err", "同意した日時の形式が正しくありません");
    const seq = one(f, "sequence_id");
    const r = await addContactManually(ctx, {
      email,
      name,
      evidence,
      tags: tagsFrom(f, "tags", "newTags"),
      ...(at ? { consentedAt: at } : {}),
      ...(seq ? { sequenceId: seq } : {}),
    });
    if (r.status === "invalid-email") return back(c, "/admin/readers/new", "err", "メールアドレスの形式が正しくありません");
    if (r.status === "blocked") return back(c, `/admin/readers/${r.contactId}`, "err", `変更しませんでした：${r.reason}`);
    await audit(ctx.db, r.status === "added" ? "reader.add" : "reader.update", r.contactId);
    const msg = r.status === "added" ? "読者を追加しました" : "既に登録されていたため、タグとシナリオを足しました";
    return back(c, `/admin/readers/${r.contactId}`, "ok", `${msg}${seq ? (r.enrolled ? "（シナリオを開始）" : "（シナリオは開始済みか、開始できませんでした）") : ""}`);
  });

  // CSV：確認（まだ登録しない）
  app.post("/readers/import/preview", async (c) => {
    const ctx = await getCtx();
    const body = await c.req.parseBody();
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    let csv = typeof body.csv === "string" ? body.csv : "";
    const file = body.file;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_CSV_BYTES) return back(c, "/admin/readers/new?tab=csv", "err", "CSV が大きすぎます（5MB まで）");
      csv = decodeCsv(new Uint8Array(await file.arrayBuffer()));
    }
    if (csv.length > MAX_CSV_BYTES) return back(c, "/admin/readers/new?tab=csv", "err", "CSV が大きすぎます（5MB まで）");
    const label = str("label");
    const evidence = str("evidence");
    if (!csv.trim()) return back(c, "/admin/readers/new?tab=csv", "err", "CSV ファイルを選ぶか、内容を貼り付けてください");
    if (!label || !evidence) return back(c, "/admin/readers/new?tab=csv", "err", "取り込み元の名前と、どのように同意を得たかを入れてください");
    let report: ImportReport;
    try {
      report = await importContacts(ctx.db, csv, { label, evidence, tags: list(str("tags")), dryRun: true });
    } catch (e) {
      return back(c, "/admin/readers/new?tab=csv", "err", e instanceof Error ? e.message : String(e));
    }
    const confirm = report.imported
      ? `<form method="post" action="/admin/readers/import" class="card">
<textarea name="csv" hidden>${h(csv)}</textarea><input type="hidden" name="label" value="${h(label)}"><input type="hidden" name="evidence" value="${h(evidence)}"><input type="hidden" name="tags" value="${h(str("tags"))}">
<p style="margin:0 0 4px">取り込み元：<b>${h(label)}</b>（タグ「${h(label)}」）${str("tags") ? `／全員に付けるタグ：${splitTags(str("tags").replace(/,/g, ";")).map((t) => `<span class="pill">${h(t)}</span>`).join("")}` : ""}</p>
<p class="muted" style="margin:0 0 4px">同意の取り方：${h(evidence)}</p>
<label class="check"><input type="checkbox" name="confirm" value="1" required>この ${report.imported} 人から配信の同意を得ていることを確認しました</label>
<div class="actions"><button type="submit">${icon("user-plus", 16)}${report.imported} 人を取り込む</button><a class="btn sub" href="/admin/readers/new?tab=csv">やり直す</a></div></form>`
      : emptyState({ icon: "inbox", title: "追加される読者はいません", text: "すべて登録済みか、読めない行でした。内容を確認してください。", action: linkButton("/admin/readers/new?tab=csv", "やり直す", "arrow-left", true) });
    const page = `${pageHeader({ title: "取り込む内容の確認", desc: "まだ登録していません。内容を確かめてから取り込んでください。", back: ["/admin/readers/new?tab=csv", "CSV で取り込む"] })}
${summary(report, false)}${confirm}<h2>内容（問題のある行を先に表示）</h2>${reportTable(report, 100)}`;
    return c.html(adminPage({ title: "取り込む内容の確認", active: "/admin/readers", body: page }));
  });

  // CSV：取り込み
  app.post("/readers/import", async (c) => {
    const ctx = await getCtx();
    const f = await readForm(c);
    if (one(f, "confirm") !== "1") return back(c, "/admin/readers/new?tab=csv", "err", "確認のチェックを入れてください");
    const csv = typeof f.csv === "string" ? f.csv : "";
    const label = one(f, "label");
    const evidence = one(f, "evidence");
    if (!csv.trim() || !label || !evidence || csv.length > MAX_CSV_BYTES) return back(c, "/admin/readers/new?tab=csv", "err", "取り込む内容が正しくありません。もう一度やり直してください");
    const report = await importContacts(ctx.db, csv, { label, evidence, tags: list(one(f, "tags")) });
    await audit(ctx.db, "reader.import", undefined, { label, imported: report.imported, skipped: report.skippedExisting, invalid: report.invalid.length });
    const page = `${pageHeader({
      title: "取り込みが終わりました",
      actions: linkButton(`/admin/readers?tag=${encodeURIComponent(label)}`, "取り込んだ読者を見る", "users"),
    })}
${summary(report, true)}${report.invalid.length || report.duplicates ? `<h2>取り込まなかった行</h2>${reportTable({ ...report, rows: report.rows.filter((x) => x.result === "invalid" || x.result === "duplicate") }, 200)}` : ""}`;
    return c.html(adminPage({ title: "取り込みが終わりました", active: "/admin/readers", body: page, flash: { kind: "ok", text: `${report.imported} 人を取り込みました` } }));
  });
}

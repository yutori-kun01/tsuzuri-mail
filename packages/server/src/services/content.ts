import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Db } from "../db.js";
import type { StepCondition } from "./sequences.js";
import { setCustomVariable } from "./variables.js";
import { validateTemplate, type PlaceholderKind } from "@tsuzuri/core";

/**
 * Markdown ファイルでシナリオ・フォーム・置き換え文字を管理し、DB に反映する。
 * 管理画面ができるまでの入力手段で、管理画面ができた後もバックアップ兼下書きとして使える。
 *
 * content/
 *   variables.json                 [{ "key": "lp_url", "value": "https://...", "kind": "url" }]
 *   topics.json                    [{ "slug": "newsletter", "name": "メルマガ本誌", "description": "...", "default_subscribed": true }]
 *   forms/<slug>.md                フォーム（本文は確認メール。.html なら HTML メール）
 *   sequences/<slug>/_sequence.md  シナリオの設定
 *   sequences/<slug>/01_xxx.md     ステップ（ファイル名の先頭の数字が順番。.html なら HTML メール）
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/** 「key: value」形式の簡易フロントマター。値は JSON として読めればその型、読めなければ文字列。 */
export function parseFrontmatter(src: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src.trim() };
  const data: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2]!.trim();
    if (raw === "") continue;
    try {
      data[kv[1]!] = JSON.parse(raw);
    } catch {
      data[kv[1]!] = raw.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: m[2]!.trim() };
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

async function ensureTag(db: Db, name: string, kind?: string): Promise<string> {
  const prefix = name.split(":")[0] ?? "";
  // kind を渡せば名前に接頭辞を付けずに種類を決められる（登録元のタグなど。画面には名前だけを出す）
  const category = kind ?? (["src", "int", "seq", "cust", "ch"].includes(prefix) ? prefix : "other");
  const [t] = await db.query<{ id: string }>(
    "INSERT INTO tags (name, category) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [name, category],
  );
  return t!.id;
}

export interface SyncReport {
  variables: number;
  sequences: string[];
  steps: number;
  forms: string[];
  problems: string[];
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** 「○分後・○時間後」の指定（delay_minutes か delay_hours）。どちらも無ければ NULL（日数と時刻で送る） */
function delayMinutes(data: Record<string, unknown>): number | null {
  if (data.delay_minutes !== undefined) return Math.max(0, Math.round(Number(data.delay_minutes) || 0));
  if (data.delay_hours !== undefined) return Math.max(0, Math.round((Number(data.delay_hours) || 0) * 60));
  return null;
}

export async function syncContent(db: Db, root: string): Promise<SyncReport> {
  const report: SyncReport = { variables: 0, sequences: [], steps: 0, forms: [], problems: [] };

  // 置き換え文字
  try {
    const vars = JSON.parse(await readFile(join(root, "variables.json"), "utf8")) as {
      key: string;
      value: string;
      kind?: PlaceholderKind;
      note?: string;
    }[];
    for (const v of vars) {
      const problem = await setCustomVariable(db, v.key, v.value, v.kind ?? "text", v.note);
      if (problem) report.problems.push(`variables.json: ${v.key}: ${problem}`);
      else report.variables++;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") report.problems.push(`variables.json: ${(e as Error).message}`);
  }
  // 配信の種類
  try {
    const topics = JSON.parse(await readFile(join(root, "topics.json"), "utf8")) as {
      slug: string;
      name: string;
      description?: string;
      default_subscribed?: boolean;
      visible?: boolean;
      position?: number;
    }[];
    for (const [i, t] of topics.entries()) {
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(t.slug) || !t.name) {
        report.problems.push(`topics.json: ${t.slug}: 識別名（英小文字・数字・ハイフン）と名前が必要です`);
        continue;
      }
      await db.query(
        `INSERT INTO topics (slug, name, description, default_subscribed, visible, position) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           default_subscribed = EXCLUDED.default_subscribed, visible = EXCLUDED.visible, position = EXCLUDED.position`,
        [t.slug, t.name, t.description ?? null, t.default_subscribed !== false, t.visible !== false, t.position ?? i],
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") report.problems.push(`topics.json: ${(e as Error).message}`);
  }

  const keys = (await db.query<{ key: string }>("SELECT key FROM custom_variables")).map((r) => r.key);
  const check = (file: string, subject: string, body: string, format: "markdown" | "html" = "markdown") => {
    for (const [t, html] of [[subject, false], [body, format === "html"]] as const) {
      const r = validateTemplate(t, keys, { html });
      if (!r.ok) report.problems.push(`${file}: 未登録の置き換え文字 ${r.unknown.map((u) => `%${u}%`).join(" ")}`);
    }
  };

  // シナリオ
  const seqRoot = join(root, "sequences");
  for (const slug of await listDir(seqRoot)) {
    const dir = join(seqRoot, slug);
    const files = await listDir(dir);
    if (files.length === 0) continue;
    const meta = files.includes("_sequence.md")
      ? parseFrontmatter(await readFile(join(dir, "_sequence.md"), "utf8")).data
      : {};
    const purpose = meta.purpose === "reengage" ? "reengage" : "normal";
    const doneTag = str(meta.done_tag);
    const doneTagId = doneTag ? await ensureTag(db, doneTag) : null;
    const topicSlug = str(meta.topic);
    const [topic] = topicSlug ? await db.query<{ id: string }>("SELECT id FROM topics WHERE slug = $1", [topicSlug]) : [];
    if (topicSlug && !topic) report.problems.push(`sequences/${slug}/_sequence.md: 配信の種類 ${topicSlug} がありません（topics.json）`);
    const [seq] = await db.query<{ id: string }>(
      `INSERT INTO sequences (slug, name, status, allow_reentry, done_tag_id, purpose, topic_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, allow_reentry = EXCLUDED.allow_reentry,
         done_tag_id = EXCLUDED.done_tag_id, purpose = EXCLUDED.purpose, topic_id = EXCLUDED.topic_id, updated_at = now()
       RETURNING id`,
      [
        slug,
        str(meta.name) ?? slug,
        str(meta.status) ?? "draft",
        // 再確認シナリオは何度でも入れるようにする
        purpose === "reengage" ? true : meta.allow_reentry === true,
        doneTagId,
        purpose,
        topic?.id ?? null,
      ],
    );
    report.sequences.push(slug);

    const stepFiles = files.filter((f) => /^\d+_.*\.(md|html)$/.test(f));
    const positions: number[] = [];
    for (const f of stepFiles) {
      const position = Number(/^(\d+)/.exec(f)![1]);
      const { data, body } = parseFrontmatter(await readFile(join(dir, f), "utf8"));
      const subject = str(data.subject) ?? basename(f).replace(/\.(md|html)$/, "");
      const format = f.endsWith(".html") || data.format === "html" ? "html" : "markdown";
      check(`sequences/${slug}/${f}`, subject, body, format);
      const condition = (data.condition as StepCondition | undefined) ?? null;
      await db.query(
        `INSERT INTO sequence_steps (sequence_id, position, delay_days, send_time, delay_minutes, channel, condition, subject, body_markdown, body_format)
         VALUES ($1, $2, $3, $4, $5, 'email', $6, $7, $8, $9)
         ON CONFLICT (sequence_id, position) DO UPDATE SET delay_days = EXCLUDED.delay_days, send_time = EXCLUDED.send_time,
           delay_minutes = EXCLUDED.delay_minutes, condition = EXCLUDED.condition, subject = EXCLUDED.subject,
           body_markdown = EXCLUDED.body_markdown, body_format = EXCLUDED.body_format`,
        [seq!.id, position, Number(data.delay_days ?? 0), str(data.send_time) ?? null, delayMinutes(data), condition && JSON.stringify(condition), subject, body, format],
      );
      positions.push(position);
      report.steps++;
    }
    await db.query("DELETE FROM sequence_steps WHERE sequence_id = $1 AND NOT (position = ANY($2::int[]))", [seq!.id, positions]);
  }

  // フォーム
  const formRoot = join(root, "forms");
  for (const f of (await listDir(formRoot)).filter((x) => /\.(md|html)$/.test(x))) {
    const slug = basename(f).replace(/\.(md|html)$/, "");
    const confirmFormat = f.endsWith(".html") ? "html" : "markdown";
    const { data, body } = parseFrontmatter(await readFile(join(formRoot, f), "utf8"));
    const tag = str(data.tag) ?? slug;
    const tagId = await ensureTag(db, tag, str(data.tag) ? undefined : "src");
    const seqSlug = str(data.sequence);
    const [seq] = seqSlug ? await db.query<{ id: string }>("SELECT id FROM sequences WHERE slug = $1", [seqSlug]) : [];
    if (seqSlug && !seq) report.problems.push(`forms/${f}: シナリオ ${seqSlug} がありません`);
    const confirmSubject = str(data.confirm_subject) ?? "【確認】登録を完了してください";
    if (body) check(`forms/${f}`, confirmSubject, body, confirmFormat);
    if (body && !/%(confirm|登録確認)(\|[^%]*)?%/.test(body)) {
      report.problems.push(`forms/${f}: 確認メールの本文に %confirm% がありません`);
    }
    const urlProblems = ["thanks_url", "sent_url", "privacy_url"].filter((k) => {
      const v = str(data[k]);
      return v !== undefined && !/^https:\/\//.test(v);
    });
    for (const k of urlProblems) report.problems.push(`forms/${f}: ${k} は https:// で始まる URL にしてください`);
    const origins = Array.isArray(data.allowed_origins) ? data.allowed_origins.map(String) : [];
    for (const o of origins) {
      if (!/^https:\/\/[^/]+$/.test(o)) report.problems.push(`forms/${f}: allowed_origins の ${o} は https://ドメイン の形にしてください`);
    }
    const cols: Record<string, unknown> = {
      name: str(data.name) ?? slug,
      tag_id: tagId,
      sequence_id: seq?.id ?? null,
      lead_magnet_key: str(data.lead_magnet) ?? null,
      consent_text_version: str(data.consent_version) ?? "v1",
      confirm_subject: confirmSubject,
      thanks_url: urlProblems.includes("thanks_url") ? null : (str(data.thanks_url) ?? null),
      active: data.active !== false,
      page_title: str(data.page_title) ?? null,
      page_description: str(data.page_description) ?? null,
      button_label: str(data.button_label) ?? "登録する",
      sent_url: urlProblems.includes("sent_url") ? null : (str(data.sent_url) ?? null),
      sent_message: str(data.sent_message) ?? null,
      confirmed_message: str(data.confirmed_message) ?? null,
      privacy_url: urlProblems.includes("privacy_url") ? null : (str(data.privacy_url) ?? null),
      allowed_origins: origins,
      confirm_body_format: confirmFormat,
      ...(body ? { confirm_body_markdown: body } : {}),
    };
    const names = Object.keys(cols);
    await db.query(
      `INSERT INTO forms (slug, ${names.join(", ")}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(", ")})
       ON CONFLICT (slug) DO UPDATE SET ${names.map((n) => `${n} = EXCLUDED.${n}`).join(", ")}`,
      [slug, ...Object.values(cols)],
    );
    report.forms.push(slug);
  }
  return report;
}

import type { Db } from "../db.js";
import { normalizeEmail } from "./subscription.js";

/** RFC 4180 の範囲の CSV を読む（ダブルクォート、カンマ・改行を含む値に対応）。 */
export function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = src.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

/**
 * アップロードされた CSV のバイト列を文字列にする。
 * UTF-8（BOM 付き・無し）として読めなければ、Excel が日本語版で書き出す Shift_JIS として読む。
 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** 見出しの別名（日本語の見出しのままでも読めるように） */
const HEADER_ALIASES: Record<string, string> = {
  email: "email",
  "e-mail": "email",
  mail: "email",
  "email address": "email",
  メールアドレス: "email",
  メール: "email",
  name: "name",
  名前: "name",
  お名前: "name",
  氏名: "name",
  ニックネーム: "name",
  呼び名: "name",
  consented_at: "consented_at",
  登録日: "consented_at",
  同意日: "consented_at",
  tags: "tags",
  タグ: "tags",
};

export function normalizeHeader(h: string): string {
  const k = h.trim().replace(/^﻿/, "").toLowerCase();
  if (k.startsWith("attr.")) return k;
  return HEADER_ALIASES[k] ?? HEADER_ALIASES[h.trim()] ?? k;
}

/** タグの文字列（「a; b」「a、b」「a|b」）を分ける。CSV のカンマとぶつからない区切りだけを使う */
export function splitTags(v: string): string[] {
  return [...new Set(v.split(/[;；、|]/).map((t) => t.trim()).filter((t) => t && t.length <= 40))];
}

export interface ImportOptions {
  /** 取り込み元の名前（取り込み元のタグ名と contacts.source に使う） */
  label: string;
  /** 同意をどう得たかの説明（同意記録として保存） */
  evidence: string;
  consentVersion?: string;
  /** 全員に付けるタグ（任意） */
  tags?: string[];
  /** true なら DB を変えずに、取り込んだ場合の結果だけを返す（確認画面用） */
  dryRun?: boolean;
}

export type ImportRowResult = "add" | "exists" | "duplicate" | "invalid";

export interface ImportRow {
  line: number;
  email: string;
  name: string;
  tags: string[];
  result: ImportRowResult;
  reason?: string;
}

export interface ImportReport {
  imported: number;
  skippedExisting: number;
  duplicates: number;
  invalid: { line: number; reason: string }[];
  rows: ImportRow[];
}

/** 一度に 1 つのトランザクションで書き込む行数 */
const CHUNK = 200;

/**
 * 既存の読者リストを取り込む。列：email（必須）、name、consented_at（日付）、tags（; 区切り）、attr.<名前>。
 * 見出しは日本語（メールアドレス、名前、登録日、タグ）でもよい。
 * 既に登録済みのアドレスは状態を変えずにスキップする（配信停止した人を勝手に戻さないため）。
 */
export async function importContacts(db: Db, csv: string, opts: ImportOptions): Promise<ImportReport> {
  const rows = parseCsv(csv);
  const header = rows.shift()?.map(normalizeHeader) ?? [];
  const col = (name: string) => header.indexOf(name);
  const emailCol = col("email");
  if (emailCol < 0) throw new Error("CSV に email（メールアドレス）の列がありません");
  const nameCol = col("name");
  const consentCol = col("consented_at");
  const tagsCol = col("tags");
  const attrCols = header.flatMap((h, i) => (h.startsWith("attr.") ? [{ key: h.slice(5), i }] : []));
  const commonTags = [...new Set((opts.tags ?? []).map((t) => t.trim()).filter(Boolean))];

  // 1 行ずつ検査する
  const report: ImportReport = { imported: 0, skippedExisting: 0, duplicates: 0, invalid: [], rows: [] };
  const seen = new Set<string>();
  const valid: { row: ImportRow; consentedAt: Date | null; attributes: Record<string, string> }[] = [];
  for (const [n, r] of rows.entries()) {
    const line = n + 2;
    const raw = (r[emailCol] ?? "").trim();
    const email = normalizeEmail(raw);
    const name = nameCol >= 0 ? (r[nameCol] ?? "").trim().slice(0, 40) : "";
    const tags = [...new Set([...commonTags, ...(tagsCol >= 0 ? splitTags(r[tagsCol] ?? "") : [])])];
    const row: ImportRow = { line, email: email ?? raw, name, tags, result: "add" };
    report.rows.push(row);
    if (!email) {
      row.result = "invalid";
      row.reason = "メールアドレスの形式が正しくありません";
      continue;
    }
    if (seen.has(email)) {
      row.result = "duplicate";
      row.reason = "同じファイルの中で重複しています";
      continue;
    }
    seen.add(email);
    const consentedAt = consentCol >= 0 && r[consentCol]?.trim() ? new Date(r[consentCol]!.trim().replace(/\//g, "-")) : null;
    if (consentedAt && Number.isNaN(consentedAt.getTime())) {
      row.result = "invalid";
      row.reason = "登録日（consented_at）の日付が読めません";
      continue;
    }
    const attributes = Object.fromEntries(attrCols.map((a) => [a.key, r[a.i] ?? ""]).filter(([, v]) => v !== ""));
    valid.push({ row, consentedAt, attributes });
  }

  // 既に登録済みのアドレスをまとめて調べる
  const existing = new Set<string>();
  const emails = valid.map((v) => v.row.email);
  for (let i = 0; i < emails.length; i += 1000) {
    const found = await db.query<{ address: string }>(
      "SELECT address FROM channels WHERE kind = 'email' AND address = ANY($1::text[])",
      [emails.slice(i, i + 1000)],
    );
    for (const f of found) existing.add(f.address);
  }
  for (const v of valid) {
    if (existing.has(v.row.email)) {
      v.row.result = "exists";
      v.row.reason = "既に登録されています（状態は変えません）";
    }
  }

  for (const r of report.rows) {
    if (r.result === "invalid") report.invalid.push({ line: r.line, reason: r.reason ?? "" });
    else if (r.result === "duplicate") report.duplicates++;
    else if (r.result === "exists") report.skippedExisting++;
  }
  const toAdd = valid.filter((v) => v.row.result === "add");
  if (opts.dryRun) {
    report.imported = toAdd.length;
    return report;
  }

  const tagIds = new Map<string, string>();
  const tagId = async (tx: Db, name: string, category: "src" | "cust") => {
    const hit = tagIds.get(name);
    if (hit) return hit;
    const [t] = await tx.query<{ id: string }>(
      "INSERT INTO tags (name, category) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [name, category],
    );
    tagIds.set(name, t!.id);
    return t!.id;
  };

  for (let i = 0; i < toAdd.length; i += CHUNK) {
    const chunk = toAdd.slice(i, i + CHUNK);
    const added = await db.transaction(async (tx) => {
      const srcTag = await tagId(tx, opts.label, "src");
      let n = 0;
      for (const { row, consentedAt, attributes } of chunk) {
        // 取り込みの途中で別の経路から登録された場合に備えて、もう一度確かめる
        const again = await tx.query("SELECT 1 FROM channels WHERE kind = 'email' AND address = $1", [row.email]);
        if (again.length > 0) {
          row.result = "exists";
          row.reason = "既に登録されています（状態は変えません）";
          continue;
        }
        const [c] = await tx.query<{ id: string }>(
          "INSERT INTO contacts (display_name, source, status, attributes) VALUES ($1, $2, 'active', $3) RETURNING id",
          [row.name || null, `import:${opts.label}`, JSON.stringify(attributes)],
        );
        const [ch] = await tx.query<{ id: string }>(
          "INSERT INTO channels (contact_id, kind, address, status) VALUES ($1, 'email', $2, 'active') RETURNING id",
          [c!.id, row.email],
        );
        await tx.query(
          `INSERT INTO consents (channel_id, method, consent_text_version, evidence, consented_at, confirmed_at)
           VALUES ($1, 'import', $2, $3, $4, $4)`,
          [ch!.id, opts.consentVersion ?? "import", JSON.stringify({ label: opts.label, evidence: opts.evidence }), consentedAt ?? new Date()],
        );
        await tx.query("INSERT INTO contact_tags (contact_id, tag_id, reason) VALUES ($1, $2, 'import')", [c!.id, srcTag]);
        for (const t of row.tags) {
          await tx.query("INSERT INTO contact_tags (contact_id, tag_id, reason) VALUES ($1, $2, 'import') ON CONFLICT DO NOTHING", [
            c!.id,
            await tagId(tx, t, "cust"),
          ]);
        }
        n++;
      }
      return n;
    });
    report.imported += added;
  }
  report.skippedExisting = report.rows.filter((r) => r.result === "exists").length;
  return report;
}

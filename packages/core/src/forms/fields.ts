/**
 * 登録フォームの入力項目（メールアドレス以外）。
 * フォームごとに forms.fields（jsonb）へ配列で保存する。メールアドレスは常に先頭の固定項目なので、ここには入れない。
 * key が "name" の項目だけは読者の表示名（contacts.display_name）に入り、それ以外は読者の属性（contacts.attributes）に入る。
 */

export const FIELD_TYPES = ["text", "textarea", "number", "select", "radio", "checkbox", "date", "hidden"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "テキスト",
  textarea: "複数行テキスト",
  number: "数値",
  select: "プルダウン",
  radio: "ラジオボタン",
  checkbox: "チェックボックス",
  date: "日付",
  hidden: "非表示",
};

export interface FormField {
  /** 属性のキー（%attr.キー% で使う）。"name" は表示名 */
  key: string;
  /** フォームに出す名前 */
  label: string;
  type: FieldType;
  required: boolean;
  /** false ならフォームに出さない（設定は残す） */
  enabled: boolean;
  /** プルダウン・ラジオ・チェックボックスの選択肢 */
  options: string[];
  /** 初期値（非表示項目では送られる値） */
  defaultValue: string;
}

/** 表示名に使う特別な項目 */
export const NAME_FIELD_KEY = "name";
/** フォームで使えないキー（固定項目・ボット対策の欄・内部用） */
const RESERVED_KEYS = new Set(["email", "website", "form", "tz", "csrf"]);
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_FIELDS = 20;
const MAX_LABEL = 40;
const MAX_OPTIONS = 30;
const MAX_OPTION_LENGTH = 60;
const MAX_VALUE = 500;
const MAX_NAME = 40;

export const DEFAULT_FIELDS: readonly FormField[] = [
  { key: NAME_FIELD_KEY, label: "お名前", type: "text", required: false, enabled: true, options: [], defaultValue: "" },
];

const hasOptions = (t: FieldType) => t === "select" || t === "radio" || t === "checkbox";

/** 「SNS, note、AI」のような入力を選択肢の配列にする（カンマ・読点・改行区切り） */
export function parseOptions(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.split(/[,、，\n]/)) {
    const v = raw.trim().slice(0, MAX_OPTION_LENGTH);
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.slice(0, MAX_OPTIONS);
}

/** DB の jsonb から読んだ値を、壊れていても安全な形にそろえる */
export function normalizeFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return DEFAULT_FIELDS.map((f) => ({ ...f }));
  const out: FormField[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const key = typeof o.key === "string" ? o.key : "";
    const type = FIELD_TYPES.includes(o.type as FieldType) ? (o.type as FieldType) : "text";
    if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) continue;
    out.push({
      key,
      label: typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, MAX_LABEL) : key,
      type: key === NAME_FIELD_KEY && type !== "text" && type !== "hidden" ? "text" : type,
      required: o.required === true,
      enabled: o.enabled !== false,
      options: Array.isArray(o.options) ? parseOptions(o.options.filter((x) => typeof x === "string").join("\n")) : [],
      defaultValue: typeof o.defaultValue === "string" ? o.defaultValue.slice(0, MAX_VALUE) : "",
    });
  }
  return out.slice(0, MAX_FIELDS);
}

/** 管理画面で入力された行（上から順）。key が空の行は新しい項目 */
export interface FieldRowInput {
  key: string;
  label: string;
  type: string;
  required: boolean;
  enabled: boolean;
  /** 選択肢、または初期値（入力形式で意味が変わる） */
  extra: string;
}

/**
 * 管理画面の表の内容を検証して保存用の配列にする。
 * 名称が空の行は無視する（空の追加行・削除した行）。新しい行には free1, free2 … の空いているキーを付ける。
 */
export function buildFields(rows: readonly FieldRowInput[]): { fields: FormField[] } | { error: string } {
  const named = rows.filter((r) => r.label.trim() !== "");
  if (named.length > MAX_FIELDS) return { error: `入力項目は ${MAX_FIELDS} 個までです` };
  const used = new Set(named.map((r) => r.key).filter(Boolean));
  let n = 1;
  const nextKey = () => {
    while (used.has(`free${n}`)) n++;
    used.add(`free${n}`);
    return `free${n}`;
  };
  const seen = new Set<string>();
  const fields: FormField[] = [];
  for (const r of named) {
    const key = r.key || nextKey();
    if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) return { error: `キー「${key}」は使えません` };
    if (seen.has(key)) return { error: `キー「${key}」が重複しています` };
    seen.add(key);
    const type = FIELD_TYPES.includes(r.type as FieldType) ? (r.type as FieldType) : "text";
    const label = r.label.trim().slice(0, MAX_LABEL);
    if (key === NAME_FIELD_KEY && type !== "text" && type !== "hidden") return { error: "「お名前」の項目はテキストか非表示にしてください" };
    const options = hasOptions(type) ? parseOptions(r.extra) : [];
    if (hasOptions(type) && options.length === 0) return { error: `「${label}」の選択肢を入れてください（カンマ区切り）` };
    const defaultValue = hasOptions(type) ? "" : r.extra.trim().slice(0, MAX_VALUE);
    if (type === "hidden" && r.required) return { error: `「${label}」は非表示なので必須にできません` };
    fields.push({ key, label, type, required: r.required, enabled: r.enabled, options, defaultValue });
  }
  return { fields };
}

export interface FieldSubmission {
  /** 表示名（name 項目） */
  name?: string;
  /** 読者の属性に入れる値 */
  attributes: Record<string, string>;
}

/**
 * フォームから送られた値を検証する。フォームで使っていない項目・知らない項目は無視する。
 * 選択肢以外の値は受け付けない（自由入力でない項目の値を勝手に作らせない）。
 */
export function validateSubmission(
  fields: readonly FormField[],
  body: Record<string, string | string[] | undefined>,
): { ok: true; value: FieldSubmission } | { ok: false; error: string } {
  const attributes: Record<string, string> = {};
  let name: string | undefined;
  for (const f of fields) {
    if (!f.enabled) continue;
    const raw = body[f.key];
    const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((v) => {
      // 制御文字は空白にする（改行は複数行テキストだけ残す）
      const s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ");
      return (f.type === "textarea" ? s : s.replace(/\n/g, " ")).trim();
    });
    let value: string;
    if (f.type === "hidden") {
      // 非表示項目は、送られてきた値（URL などから差し替えたもの）があればそれを、なければ初期値を使う
      value = (values[0] ?? "") || f.defaultValue;
    } else if (f.type === "checkbox") {
      const picked = values.filter((v) => f.options.includes(v));
      if (picked.length !== values.filter(Boolean).length) return { ok: false, error: `「${f.label}」の選択肢を確認してください` };
      value = f.options.filter((o) => picked.includes(o)).join(", ");
    } else {
      value = values[0] ?? "";
      if ((f.type === "select" || f.type === "radio") && value && !f.options.includes(value)) {
        return { ok: false, error: `「${f.label}」の選択肢を確認してください` };
      }
      if (f.type === "number" && value && !/^-?\d+(\.\d+)?$/.test(value)) return { ok: false, error: `「${f.label}」は数字で入力してください` };
      if (f.type === "date" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, error: `「${f.label}」の日付を確認してください` };
    }
    if (f.required && !value) return { ok: false, error: `「${f.label}」を入力してください` };
    const max = f.key === NAME_FIELD_KEY ? MAX_NAME : MAX_VALUE;
    if (value.length > max) return { ok: false, error: `「${f.label}」は ${max} 文字以内で入力してください` };
    if (!value) continue;
    if (f.key === NAME_FIELD_KEY) name = value;
    else attributes[f.key] = value;
  }
  return { ok: true, value: { ...(name ? { name } : {}), attributes } };
}

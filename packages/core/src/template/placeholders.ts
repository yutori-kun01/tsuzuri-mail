/**
 * 置き換え文字（プレースホルダ）。
 *
 * 書き方
 *   %cancel%           組み込み（配信停止URLなど）。日本語の別名 %配信解除% も使える
 *   %name|読者さん%     値が空のときの代わりの文字（フォールバック）
 *   %lp_url%           独自の置き換え文字（管理画面で登録した共通の値）
 *   %attr.job%         読者ごとの属性（contacts.attributes の値）
 *   %%                 「%」そのもの
 *
 * 未登録の置き換え文字は送信前の検証でエラーにする（%cancell% のような打ち間違いをそのまま送らないため）。
 */

export type PlaceholderKind = "text" | "url";

export interface BuiltinDef {
  key: string;
  aliases: readonly string[];
  kind: PlaceholderKind;
  description: string;
  /** クリック計測の対象外にする（配信停止など） */
  untracked?: boolean;
}

export const BUILTINS: readonly BuiltinDef[] = [
  { key: "cancel", aliases: ["配信解除", "配信停止", "unsubscribe"], kind: "url", untracked: true, description: "配信停止ページのURL" },
  { key: "settings", aliases: ["配信設定"], kind: "url", untracked: true, description: "配信設定ページのURL" },
  { key: "confirm", aliases: ["登録確認"], kind: "url", untracked: true, description: "登録確認（ダブルオプトイン）のURL。確認メール専用" },
  { key: "download", aliases: ["特典", "ダウンロード"], kind: "url", untracked: true, description: "特典ファイルのダウンロードURL（押されると目標行動として記録）" },
  { key: "webview", aliases: ["Web版", "web版"], kind: "url", description: "この号のWeb版URL" },
  { key: "name", aliases: ["名前", "呼び名"], kind: "text", description: "読者の呼び名" },
  { key: "email", aliases: ["メールアドレス"], kind: "text", description: "読者のメールアドレス" },
  { key: "date", aliases: ["日付"], kind: "text", description: "送信日（例：2026年11月13日）" },
  { key: "sender", aliases: ["送信者"], kind: "text", description: "送信者名" },
  { key: "contact", aliases: ["問い合わせ先"], kind: "text", description: "問い合わせ先（法定表示）" },
  { key: "sender_info", aliases: ["送信者情報"], kind: "url", untracked: true, description: "送信者情報（住所・問い合わせ先）のページのURL。フッター用" },
  { key: "subscribed_date", aliases: ["登録日"], kind: "text", description: "読者の登録日" },
];

const builtinByName = new Map<string, BuiltinDef>();
for (const b of BUILTINS) {
  builtinByName.set(b.key, b);
  for (const a of b.aliases) builtinByName.set(a, b);
}

export function resolveBuiltin(name: string): BuiltinDef | undefined {
  return builtinByName.get(name);
}

/** 独自の置き換え文字の名前として使えるか（組み込みと衝突しない、記号を含まない） */
export function validateCustomKey(key: string): string | undefined {
  if (!/^[^\s%|.:]{1,40}$/u.test(key)) return "空白・%・|・.・: を含まない40文字以内にしてください";
  if (builtinByName.has(key)) return "組み込みの置き換え文字と同じ名前は使えません";
  if (key.startsWith("attr")) return "attr で始まる名前は読者属性用に予約されています";
  return undefined;
}

export interface CustomVariable {
  key: string;
  value: string;
  kind: PlaceholderKind;
}

export interface PlaceholderToken {
  /** 元の文字列（%...%） */
  raw: string;
  name: string;
  fallback: string | undefined;
  start: number;
  end: number;
}

/** %name% / %name|fallback% / %attr.x% を拾う。%% はエスケープ。 */
const TOKEN_RE = /%%|%([^\s%|]{1,64})(?:\|([^%\n]{0,200}))?%/gu;

export function scan(template: string): PlaceholderToken[] {
  const out: PlaceholderToken[] = [];
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m[0] === "%%") continue;
    out.push({ raw: m[0], name: m[1]!, fallback: m[2], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export interface ValidationResult {
  ok: boolean;
  unknown: string[];
}

/** 未登録の置き換え文字を列挙する。保存・送信前に呼ぶ。 */
export function validateTemplate(template: string, customKeys: Iterable<string>): ValidationResult {
  const custom = new Set(customKeys);
  const unknown = new Set<string>();
  for (const t of scan(template)) {
    if (resolveBuiltin(t.name) || custom.has(t.name) || t.name.startsWith("attr.")) continue;
    unknown.add(t.name);
  }
  return { ok: unknown.size === 0, unknown: [...unknown] };
}

export interface PlaceholderContext {
  builtins: Partial<Record<string, string>>;
  custom: readonly CustomVariable[];
  attributes: Record<string, unknown>;
}

export interface ResolvedValue {
  value: string;
  kind: PlaceholderKind;
  untracked: boolean;
}

export function resolve(token: PlaceholderToken, ctx: PlaceholderContext): ResolvedValue {
  const b = resolveBuiltin(token.name);
  let value: string | undefined;
  let kind: PlaceholderKind = "text";
  let untracked = false;
  if (b) {
    value = ctx.builtins[b.key];
    kind = b.kind;
    untracked = b.untracked ?? false;
  } else if (token.name.startsWith("attr.")) {
    const v = ctx.attributes[token.name.slice(5)];
    value = v === undefined || v === null ? undefined : String(v);
  } else {
    const c = ctx.custom.find((x) => x.key === token.name);
    value = c?.value;
    kind = c?.kind ?? "text";
  }
  if (value === undefined || value === "") value = token.fallback ?? "";
  return { value, kind, untracked };
}

/**
 * 置き換え文字を値に置き換える（件名やテキスト版用）。
 * 本文の HTML 化は render.ts が担当する。
 */
export function substitute(template: string, ctx: PlaceholderContext): string {
  return template.replace(TOKEN_RE, (whole) => {
    if (whole === "%%") return "%";
    const t = scan(whole)[0]!;
    return resolve(t, ctx).value;
  });
}

/** 置き換え文字を目印に置き換え、目印→値の表を返す（Markdown 変換をまたぐため）。 */
export function tokenize(
  template: string,
  ctx: PlaceholderContext,
): { text: string; values: Map<string, ResolvedValue> } {
  const values = new Map<string, ResolvedValue>();
  let n = 0;
  const text = template.replace(TOKEN_RE, (whole) => {
    if (whole === "%%") return "%";
    const t = scan(whole)[0]!;
    const marker = `TZPH${n++}X`;
    values.set(marker, resolve(t, ctx));
    return marker;
  });
  return { text, values };
}

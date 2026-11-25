import { createRequire } from "node:module";

/**
 * Lucide のアイコン（lucide-static、ISC ライセンス）をサーバー側で SVG にする。
 * 外部への読み込みは発生しない。色は currentColor（文字色）に従う。
 */
type IconNode = [string, Record<string, string | number>][];

const require = createRequire(import.meta.url);
let nodes: Record<string, IconNode> | undefined;

function load(): Record<string, IconNode> {
  nodes ??= require("lucide-static/icon-nodes.json") as Record<string, IconNode>;
  return nodes;
}

const esc = (v: string | number) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** 管理画面で使うアイコンの名前（存在しない名前は型で弾く） */
export type IconName =
  | "house"
  | "send"
  | "workflow"
  | "scroll-text"
  | "users"
  | "file-input"
  | "tags"
  | "braces"
  | "settings"
  | "log-out"
  | "plus"
  | "search"
  | "mail-check"
  | "user-plus"
  | "triangle-exclamation-point"
  | "circle-check"
  | "circle-x"
  | "chart-no-axes-column"
  | "eye"
  | "flask-conical"
  | "calendar-clock"
  | "arrow-left"
  | "mouse-pointer-click"
  | "inbox"
  | "pause"
  | "copy"
  | "external-link"
  | "x"
  | "list-checks"
  | "circle"
  | "tag"
  | "layers"
  | "menu"
  | "mail"
  | "calendar"
  | "arrow-right"
  | "shield-check"
  | "info"
  | "upload"
  | "panel-bottom"
  | "star"
  | "power"
  | "power-off"
  | "zap"
  | "arrow-down"
  | "split"
  | "flag"
  | "log-in"
  | "test-tube"
  | "clock"
  | "grip-vertical"
  | "lock"
  | "code"
  | "trash"
  | "layout-template"
  | "globe"
  | "pencil"
  | "folder"
  | "arrow-up";

export function icon(name: IconName, size = 16, cls = "icon"): string {
  const node = load()[name];
  if (!node) return "";
  const children = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}/>`).join("");
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

/** 使っているアイコンがすべて実在するか（テスト用） */
export function missingIcons(names: readonly string[]): string[] {
  const all = load();
  return names.filter((n) => !all[n]);
}

/** htmx の本体（自分のサーバーから配る） */
export function htmxScriptPath(): string {
  return require.resolve("htmx.org/dist/htmx.min.js");
}

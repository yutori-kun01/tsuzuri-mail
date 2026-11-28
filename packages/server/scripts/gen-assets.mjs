// 管理画面で使う外部の資源（htmx、Lucide のアイコン）を TypeScript のファイルに書き出す。
// Cloudflare Workers ではファイルを読めないので、コードとして取り込む。
// htmx や lucide-static の版を上げたら `pnpm gen:assets` を実行する（test/ui.test.ts が食い違いを見つける）。
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

const htmxPath = require.resolve("htmx.org/dist/htmx.min.js");
const htmxVersion = JSON.parse(readFileSync(require.resolve("htmx.org/package.json"), "utf8")).version;
const htmx = readFileSync(htmxPath, "utf8");
writeFileSync(
  new URL("src/admin/generated/htmx.ts", root),
  `// 自動生成（scripts/gen-assets.mjs）。手で編集しない。\n// htmx ${htmxVersion}（BSD Zero Clause License, https://github.com/bigskysoftware/htmx）\nexport const HTMX_VERSION = ${JSON.stringify(htmxVersion)};\nexport const HTMX_SOURCE = ${JSON.stringify(htmx)};\n`,
);

const iconsSrc = readFileSync(new URL("src/admin/icons.ts", root), "utf8");
const block = iconsSrc.slice(iconsSrc.indexOf("export type IconName"), iconsSrc.indexOf("export function icon"));
const names = [...new Set([...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const all = JSON.parse(readFileSync(require.resolve("lucide-static/icon-nodes.json"), "utf8"));
const lucideVersion = JSON.parse(readFileSync(require.resolve("lucide-static/package.json"), "utf8")).version;
const missing = names.filter((n) => !all[n]);
if (missing.length) throw new Error(`lucide に無いアイコン: ${missing.join(", ")}`);
const subset = Object.fromEntries(names.map((n) => [n, all[n]]));
writeFileSync(
  new URL("src/admin/generated/icon-nodes.ts", root),
  `// 自動生成（scripts/gen-assets.mjs）。手で編集しない。\n// Lucide ${lucideVersion}（ISC License, https://lucide.dev）から、管理画面で使うものだけ\nexport const LUCIDE_VERSION = ${JSON.stringify(lucideVersion)};\nexport const ICON_NODES: Record<string, [string, Record<string, string | number>][]> = ${JSON.stringify(subset)};\n`,
);
console.log(`htmx ${htmxVersion}, icons ${names.length}`);

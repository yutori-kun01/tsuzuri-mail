import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { createToken, verifyToken } from "@tsuzuri/core";
import type { FileStorage } from "../context.js";
import type { BackupWriter } from "../services/backup.js";

/** 特典ファイルのリンクの有効時間 */
const FILE_LINK_MINUTES = 10;

/**
 * VPS のディスクに置いた特典ファイルを配る。
 * ダウンロード URL は「キーと有効期限」に署名したもので、/files/<token> で配信する。
 */
export class LocalFileStorage implements FileStorage {
  constructor(
    readonly dir: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async downloadUrl(key: string): Promise<string> {
    const exp = this.now().getTime() + FILE_LINK_MINUTES * 60_000;
    return `${this.publicBaseUrl}/files/${createToken("file", `${exp}|${key}`, this.secret)}`;
  }

  /** トークンを確かめ、配信してよいファイルの絶対パスを返す（期限切れ・ディレクトリ外は undefined） */
  resolveToken(token: string): string | undefined {
    const subject = verifyToken(token, "file", this.secret);
    if (!subject) return undefined;
    const bar = subject.indexOf("|");
    const exp = Number(subject.slice(0, bar));
    const key = subject.slice(bar + 1);
    if (!Number.isFinite(exp) || exp < this.now().getTime() || !key) return undefined;
    const root = resolve(this.dir);
    const full = resolve(root, normalize(key));
    if (!full.startsWith(root + sep)) return undefined;
    return full;
  }
}

/** 毎晩のバックアップをディスクに書き、古いものを消す */
export function localBackupWriter(dir: string, day: string): BackupWriter {
  return {
    async write(name, ndjson) {
      const target = join(dir, day);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await writeFile(join(target, `${name}.ndjson.gz`), gzipSync(ndjson), { mode: 0o600 });
    },
  };
}

export async function pruneLocalBackups(dir: string, keepDays: number, now: Date): Promise<number> {
  let removed = 0;
  const edge = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < edge) {
      await rm(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

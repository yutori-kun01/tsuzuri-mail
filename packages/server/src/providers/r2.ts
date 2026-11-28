import type { FileStorage } from "../context.js";
import { baseName, createFileToken, verifyFileToken, type FileDownload } from "./files.js";

/**
 * Cloudflare R2 の保存先。Workers のバインディング（env.FILES、env.BACKUPS）をそのまま受け取る。
 * 型は使う部分だけを書いておく（@cloudflare/workers-types を Node 側の型と混ぜないため）。
 */
export interface R2ObjectLike {
  key: string;
  size: number;
  uploaded: Date;
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream;
}
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

/** 特典ファイルを R2 から配る。リンクは署名付き・10 分で期限切れ（/files/<token>） */
export class R2FileStorage implements FileStorage {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async downloadUrl(key: string): Promise<string> {
    return `${this.publicBaseUrl}/files/${createFileToken(key, this.secret, this.now())}`;
  }

  async open(token: string): Promise<FileDownload | undefined> {
    const key = verifyFileToken(token, this.secret, this.now());
    if (!key) return undefined;
    const obj = await this.bucket.get(key);
    return obj ? { body: obj.body, size: obj.size, name: baseName(key) } : undefined;
  }
}

import { createToken, verifyToken } from "@tsuzuri/core";

/** 特典ファイルのリンクの有効時間 */
export const FILE_LINK_MINUTES = 10;

/** /files/<token> で返すファイル */
export interface FileDownload {
  body: ReadableStream;
  size: number;
  /** 保存するときのファイル名（キーの最後の部分） */
  name: string;
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  epub: "application/epub+zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

export function contentTypeOf(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function baseName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** 「キーと有効期限」に署名したトークン */
export function createFileToken(key: string, secret: string, now: Date): string {
  const exp = now.getTime() + FILE_LINK_MINUTES * 60_000;
  return createToken("file", `${exp}|${key}`, secret);
}

/** トークンを確かめ、期限内ならキーを返す（ディレクトリをさかのぼるキーは受け付けない） */
export function verifyFileToken(token: string, secret: string, now: Date): string | undefined {
  const subject = verifyToken(token, "file", secret);
  if (!subject) return undefined;
  const bar = subject.indexOf("|");
  const exp = Number(subject.slice(0, bar));
  const key = subject.slice(bar + 1);
  if (!Number.isFinite(exp) || exp < now.getTime() || !key) return undefined;
  if (key.startsWith("/") || key.split(/[\\/]/).some((p) => p === ".." || p === "")) return undefined;
  return key;
}

/** ダウンロードの応答 */
export function downloadResponse(f: FileDownload): Response {
  return new Response(f.body, {
    headers: {
      "Content-Type": contentTypeOf(f.name),
      "Content-Length": String(f.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** 表示名に ASCII 以外を含む場合は RFC 2047 の encoded-word にする（SES の要件） */
export function formatFrom(address: string, name?: string): string {
  if (!name) return address;
  const ascii = /^[\x20-\x7e]*$/.test(name);
  const display = ascii ? `"${name.replace(/["\\]/g, "\\$&")}"` : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
  return `${display} <${address}>`;
}

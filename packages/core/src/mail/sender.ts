/**
 * 送信元（差出人）の設定。シナリオや一斉配信ごとに、送信者名・送信元アドレス・返信先を変えられる。
 * 送信元アドレスのドメインは、SES で認証した送信ドメインのどれかでなければならない（AWS 側の権限もそのドメインに絞っている）。
 */

export interface SenderOverride {
  fromName?: string | null;
  fromAddress?: string | null;
  replyTo?: string | null;
}

export interface Sender {
  fromName: string;
  fromAddress: string;
  replyTo?: string;
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/;

/** 「ml.example.com」の形か（小文字にそろえてから確かめる） */
export function isDomainName(s: string): boolean {
  return DOMAIN_RE.test(s.trim().toLowerCase());
}

export function emailDomain(address: string): string | undefined {
  const a = address.trim().toLowerCase();
  if (!EMAIL_RE.test(a)) return undefined;
  const d = a.slice(a.lastIndexOf("@") + 1);
  return isDomainName(d) ? d : undefined;
}

/** 送信に使ってよいドメイン（既定の送信元のドメインと、追加した送信ドメイン。重複なし・小文字） */
export function allowedSenderDomains(defaultFromAddress: string, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const d of [emailDomain(defaultFromAddress), ...extra.map((x) => x.trim().toLowerCase())]) {
    if (d && isDomainName(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** 管理画面で入力された送信者の上書きを検証する。空欄は「全体の設定を使う」 */
export function checkSenderOverride(o: SenderOverride, domains: readonly string[]): string | undefined {
  const name = (o.fromName ?? "").trim();
  if (name.length > 60) return "送信者名は 60 文字以内にしてください";
  if (/[\r\n<>"]/.test(name)) return "送信者名に改行や < > \" は使えません";
  const from = (o.fromAddress ?? "").trim();
  if (from) {
    const d = emailDomain(from);
    if (!d) return "送信元アドレスの形を確認してください";
    if (!domains.includes(d)) return `送信元アドレスのドメイン「${d}」は送信ドメインに登録されていません（設定 → 送信ドメイン）`;
  }
  const reply = (o.replyTo ?? "").trim();
  if (reply && !emailDomain(reply)) return "返信先アドレスの形を確認してください";
  return undefined;
}

/** 全体の設定に、シナリオ・一斉配信ごとの上書きを重ねる（空欄の項目は全体の設定のまま） */
export function resolveSender(base: Sender, o: SenderOverride | null | undefined): Sender {
  const pick = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
  const replyTo = pick(o?.replyTo) ?? base.replyTo;
  return {
    fromName: pick(o?.fromName) ?? base.fromName,
    fromAddress: pick(o?.fromAddress)?.toLowerCase() ?? base.fromAddress,
    ...(replyTo ? { replyTo } : {}),
  };
}

export interface DnsRecord {
  type: "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
  /** 何のためのレコードか */
  purpose: string;
}

/**
 * SES の送信ドメインに必要な DNS レコード（Easy DKIM の 3 本、MAIL FROM の MX と SPF、DMARC）。
 * MAIL FROM は bounce.<ドメイン>（送信元ドメインとそろえて SPF の整合を取る）。
 */
export function sesDnsRecords(domain: string, dkimTokens: readonly string[], region = "ap-northeast-1"): DnsRecord[] {
  const d = domain.trim().toLowerCase();
  return [
    ...dkimTokens.map((t) => ({ type: "CNAME" as const, name: `${t}._domainkey.${d}`, value: `${t}.dkim.amazonses.com`, purpose: "DKIM（署名）" })),
    { type: "MX", name: `bounce.${d}`, value: `10 feedback-smtp.${region}.amazonses.com`, purpose: "MAIL FROM（バウンスの受け取り）" },
    { type: "TXT", name: `bounce.${d}`, value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" },
    { type: "TXT", name: `_dmarc.${d}`, value: "v=DMARC1; p=none;", purpose: "DMARC（まずは p=none で様子を見る）" },
  ];
}

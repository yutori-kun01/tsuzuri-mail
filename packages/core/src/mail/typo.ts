/**
 * 主要なメールサービスのドメインの打ち間違いを見つけて、正しいと思われるアドレスを返す。
 * 例：taro@gmial.com → taro@gmail.com、hanako@yahoo.jp → hanako@yahoo.co.jp
 * 実在する別のサービス（mail.com など）には候補を出さない。
 */

const MAJOR_DOMAINS = [
  "gmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.co.jp",
  "yahoo.com",
  "outlook.com",
  "outlook.jp",
  "hotmail.com",
  "hotmail.co.jp",
  "live.jp",
  "docomo.ne.jp",
  "ezweb.ne.jp",
  "au.com",
  "softbank.ne.jp",
  "i.softbank.jp",
] as const;

/** 主要ドメインに似ているが実在する別のドメイン（候補を出さない） */
const REAL_LOOKALIKES = new Set([
  "mail.com",
  "email.com",
  "gmx.com",
  "ymail.com",
  "live.com",
  "msn.com",
  "aol.com",
  "yahoo.co.uk",
  "hotmail.co.uk",
  "outlook.co.jp",
  "ybb.ne.jp",
  "nifty.com",
  "ocn.ne.jp",
  "biglobe.ne.jp",
  "so-net.ne.jp",
  "plala.or.jp",
  "zoho.com",
  "proton.me",
  "protonmail.com",
]);

/** 距離では拾いにくい、よくある取り違え */
const KNOWN_MISTAKES: Record<string, string> = {
  "gmail.jp": "gmail.com",
  "gmail.co.jp": "gmail.com",
  "gmail.ne.jp": "gmail.com",
  "gmai.com": "gmail.com",
  "googlemail.co.jp": "gmail.com",
  "icloud.jp": "icloud.com",
  "icloud.co.jp": "icloud.com",
  "icloud.ne.jp": "icloud.com",
  "yahoo.jp": "yahoo.co.jp",
  "yahoo.ne.jp": "yahoo.co.jp",
  "yahoo.com.jp": "yahoo.co.jp",
  "yahoo.cojp": "yahoo.co.jp",
  "docomo.co.jp": "docomo.ne.jp",
  "docomo.jp": "docomo.ne.jp",
  "docomo.com": "docomo.ne.jp",
  "ezweb.co.jp": "ezweb.ne.jp",
  "ezweb.jp": "ezweb.ne.jp",
  "softbank.co.jp": "softbank.ne.jp",
  "softbank.jp": "i.softbank.jp",
  "outlook.co": "outlook.com",
  "hotmail.jp": "hotmail.co.jp",
};

/** 入れ替え（ab → ba）を 1 回と数える編集距離（最適文字列アラインメント） */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** 打ち間違いと思われるときだけ、直したアドレスを返す（大文字小文字は区別しない） */
export function suggestEmailFix(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0) return undefined;
  const local = email.slice(0, at).trim();
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
  if (!local || !domain || (MAJOR_DOMAINS as readonly string[]).includes(domain) || REAL_LOOKALIKES.has(domain)) return undefined;
  const known = KNOWN_MISTAKES[domain];
  if (known) return `${local}@${known}`;
  let best: { d: string; dist: number } | undefined;
  let tie = false;
  for (const d of MAJOR_DOMAINS) {
    const dist = editDistance(domain, d);
    // 短いドメイン（au.com・me.com など）は 1 文字違いまで。それ以外は 2 文字違いまで
    const limit = d.length <= 7 ? 1 : 2;
    if (dist > limit) continue;
    if (!best || dist < best.dist) {
      best = { d, dist };
      tie = false;
    } else if (dist === best.dist) tie = true;
  }
  return best && !tie ? `${local}@${best.d}` : undefined;
}

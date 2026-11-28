/**
 * Amazon SES の送信料金の目安。
 * 料金はアカウント・リージョン・時期で変わるので、単価は画面で入れてもらう（既定値は docs/requirements.md に書いた導入時の値）。
 * 計算するのは「送信通数 × 単価」だけ。添付ファイルなどのデータ量の料金、専用 IP、無料枠、税などは含めない。
 */

/** 導入時に docs/requirements.md に記録した単価（送信 1,000 通あたりの USD）。公式ページで確かめて画面で変える */
export const DEFAULT_SES_PRICE_PER_1000_USD = 0.1;

export function sesCostUsd(emails: number, pricePer1000Usd: number): number {
  if (!Number.isFinite(emails) || emails <= 0 || !Number.isFinite(pricePer1000Usd) || pricePer1000Usd <= 0) return 0;
  return (emails / 1000) * pricePer1000Usd;
}

export interface SesPlan {
  /** 配信中の読者数 */
  readers: number;
  /** 月あたりの一斉配信の回数 */
  broadcastsPerMonth: number;
  /** 月あたりの新しい登録 */
  signupsPerMonth: number;
  /** 登録した人 1 人に届くシナリオの通数 */
  stepsPerSignup: number;
  /** 確認メールを送るか（ダブルオプトイン） */
  confirmationEmail: boolean;
}

export interface SesEstimate {
  broadcastEmails: number;
  sequenceEmails: number;
  confirmationEmails: number;
  total: number;
  usd: number;
}

export function estimateMonthlySes(p: SesPlan, pricePer1000Usd: number): SesEstimate {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const broadcastEmails = Math.round(n(p.readers) * n(p.broadcastsPerMonth));
  const sequenceEmails = Math.round(n(p.signupsPerMonth) * n(p.stepsPerSignup));
  const confirmationEmails = p.confirmationEmail ? Math.round(n(p.signupsPerMonth)) : 0;
  const total = broadcastEmails + sequenceEmails + confirmationEmails;
  return { broadcastEmails, sequenceEmails, confirmationEmails, total, usd: sesCostUsd(total, pricePer1000Usd) };
}

/** 月の途中の通数から、その月の見込み（日割りでのばす） */
export function projectMonth(sentSoFar: number, dayOfMonth: number, daysInMonth: number): number {
  if (dayOfMonth <= 0 || daysInMonth <= 0) return sentSoFar;
  return Math.round((sentSoFar / Math.min(dayOfMonth, daysInMonth)) * daysInMonth);
}

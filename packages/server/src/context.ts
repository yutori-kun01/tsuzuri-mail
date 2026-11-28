import { allowedSenderDomains, type CommerceDisclosure, type MailProvider, type PaymentProvider } from "@tsuzuri/core";
import type { Db } from "./db.js";

/** 送信者表示などの設定（app_settings に保存。無ければ環境変数の値を使う） */
export interface AppSettings {
  fromAddress: string;
  fromName: string;
  replyTo?: string;
  /** 法定表示：送信者の氏名・名称 */
  senderName: string;
  /** 法定表示：送信者の住所（メール本文には出さず、/legal ページに表示する） */
  senderAddress?: string;
  /** 住所などを載せた自前のページがあればその URL（無ければ /legal を使う） */
  senderInfoUrl?: string;
  /** 法定表示：問い合わせ先（URL かメールアドレス） */
  contact: string;
  footerExtraLines?: string[];
  /** 確認メールなどで使う既定の呼び名 */
  defaultName?: string;
  /** 管理画面のテスト送信先（サンドボックス中は SES で検証済みのアドレスに限る） */
  testRecipients?: string[];
  /** 追加の送信ドメイン（シナリオ・一斉配信ごとに別のドメインから送るため。AWS 側は infra/tsuzuri.local.json の tsuzuri:extraSendingDomains） */
  sendingDomains?: string[];
  /** SES の料金の目安：送信 1,000 通あたりの USD（料金の目安の画面で入れる） */
  sesPricePer1000Usd?: number;
  /** 料金の目安を円でも見るときの為替（1 USD あたりの円。空なら円は出さない） */
  usdJpy?: number;
  /** 特定商取引法に基づく表記（/legal/commerce に自動で出す。商品を売るときに入れる） */
  commerce?: CommerceDisclosure;
}

/** SES の送信ドメイン（ID）の状態。管理画面の「送信ドメイン」で表示する */
export interface IdentityStatus {
  /** SES に ID が無い（AWS 側に未登録） */
  found: boolean;
  verified?: boolean;
  dkimStatus?: string;
  dkimTokens?: string[];
  mailFromDomain?: string;
  mailFromStatus?: string;
  error?: string;
}

export interface FileStorage {
  /** 特典ファイルの一時ダウンロード URL を発行する */
  downloadUrl(key: string): Promise<string>;
  /** /files/<token> で自分で配る保存先（VPS のディスク、Cloudflare R2）だけが持つ。期限切れ・無いときは undefined */
  open?(token: string): Promise<import("./providers/files.js").FileDownload | undefined>;
}

/** 管理者のログイン情報（どちらも無ければ管理画面は使えない） */
export interface AdminCredentials {
  /** hashPassword() の結果 */
  passwordHash: string;
  /** 認証アプリ用の鍵（Base32） */
  totpSecret: string;
  /**
   * パスワード＋認証アプリでのログインを受け付けるか（既定 true）。false にするとパスキーだけで入る。
   * パスキーが 1 つも登録されていないときは、締め出しを防ぐため false でも受け付ける。
   */
  passwordLogin?: boolean;
}

export interface AppContext {
  db: Db;
  provider: MailProvider;
  /**
   * アプリ自身の URL（https://... 末尾スラッシュなし）。Cloudflare 版では workers.dev の URL。
   * フォームの送信先、List-Unsubscribe ヘッダー、パスキーの RP ID、CSRF の確認に使う。
   */
  publicBaseUrl: string;
  /**
   * メール本文に入れるリンクの基点（任意。無ければ publicBaseUrl）。
   * 例：本文のリンクは https://ml.example.com にして、そこからアプリへ転送する。
   * ここに置いたドメインでは、/c /o /d /u /p /confirm /w /legal /f をアプリへ転送（GET）できる必要がある。
   */
  linkBaseUrl?: string;
  /**
   * 管理画面を別のホストで開くときの、そのホストの URL（任意。無ければ publicBaseUrl）。
   * Cloudflare で管理画面を別の Worker にしたときに使う。パスキーはこのホスト名に結びつく。
   */
  adminBaseUrl?: string;
  /** 署名付きトークンの鍵（32文字以上） */
  secret: string;
  settings: AppSettings;
  storage?: FileStorage;
  admin?: AdminCredentials;
  now: () => Date;
  /** SES の ID の状態を読む（AWS の認証情報があるときだけ。読み取り専用） */
  identityStatus?: (domain: string) => Promise<IdentityStatus>;
  /** 決済サービス（Webhook の受け口 /hooks/<name>）。設定したものだけ */
  payments?: PaymentProvider[];
  /** 毎晩のバックアップの置き場所（Cloudflare R2）。管理画面の「バックアップ」で使う */
  backups?: { bucket: import("./providers/r2.js").R2BucketLike; key?: Buffer; keepDays: number };
}

/** 送信元に使ってよいドメイン（既定の送信元のドメイン＋追加の送信ドメイン） */
export function senderDomains(ctx: AppContext): string[] {
  return allowedSenderDomains(ctx.settings.fromAddress, ctx.settings.sendingDomains ?? []);
}

/** 設定を DB から読み直す（管理画面で変えた値を、ほかの Lambda にも反映するため） */
export async function refreshSettings(ctx: AppContext): Promise<void> {
  ctx.settings = await loadSettings(ctx.db, ctx.settings);
}

/** アプリ自身の URL（フォームの送信先・ヘッダー・API 用） */
export function url(ctx: AppContext, path: string): string {
  return `${ctx.publicBaseUrl}${path}`;
}

/** メール本文や、読者に見せるために貼る URL（LINK_BASE_URL があればそちら） */
export function linkUrl(ctx: AppContext, path: string): string {
  return `${ctx.linkBaseUrl || ctx.publicBaseUrl}${path}`;
}

/** 特定電子メール法の表示に必要な項目のうち、未設定のもの */
export function missingLegalFields(s: AppSettings): string[] {
  const missing: string[] = [];
  if (!s.senderName.trim()) missing.push("senderName（送信者の氏名・名称）");
  if (!s.senderAddress?.trim() && !s.senderInfoUrl?.trim()) missing.push("senderAddress（住所）または senderInfoUrl（送信者情報ページ）");
  if (!s.contact.trim()) missing.push("contact（問い合わせ先）");
  if (!s.fromAddress.trim()) missing.push("fromAddress（送信元アドレス）");
  return missing;
}

/** メールのフッターからリンクする送信者情報ページ */
export function senderInfoUrl(ctx: AppContext): string {
  return ctx.settings.senderInfoUrl?.trim() || linkUrl(ctx, "/legal");
}

export async function loadSettings(db: Db, fallback: AppSettings): Promise<AppSettings> {
  const rows = await db.query<{ settings: Partial<AppSettings> }>("SELECT settings FROM app_settings WHERE id = 1");
  return { ...fallback, ...(rows[0]?.settings ?? {}) };
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): AppSettings {
  const replyTo = env.MAIL_REPLY_TO;
  return {
    fromAddress: env.MAIL_FROM_ADDRESS ?? "",
    fromName: env.MAIL_FROM_NAME ?? "",
    ...(replyTo ? { replyTo } : {}),
    senderName: env.MAIL_FROM_NAME ?? "",
    contact: env.MAIL_CONTACT ?? replyTo ?? "",
  };
}

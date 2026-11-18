import {
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
} from "@aws-sdk/client-sesv2";
import { missingLegalFields, type AppContext } from "../context.js";

/**
 * 本番前の自己点検（SES の本番申請の前に、チェックリストを機械的に確かめる）。
 * 秘密値は表示しない。AWS の確認は、認証情報がある環境（手元の SSO や VPS）でだけ行う。
 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** テストで差し替えられるよう、SES クライアントは send だけを使う */
export interface SesLike {
  send(command: unknown): Promise<unknown>;
}

export interface DoctorOptions {
  ses?: SesLike;
  configurationSet?: string;
  /** 公開 URL に実際にアクセスして確かめるか */
  checkHttp?: boolean;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });
const skip = (name: string, detail: string): CheckResult => ({ name, status: "skip", detail });

export async function runDoctor(ctx: AppContext, opts: DoctorOptions = {}): Promise<CheckResult[]> {
  const env = opts.env ?? process.env;
  const out: CheckResult[] = [];
  const s = ctx.settings;
  const domain = s.fromAddress.split("@")[1] ?? "";

  // ---- 法定表示と送信者 ----
  const missing = missingLegalFields(s);
  out.push(missing.length ? fail("法定表示", `未設定：${missing.join("、")}`) : ok("法定表示", "送信者名・問い合わせ先・住所（またはそのページ）・送信元が設定済み"));
  out.push((s.testRecipients ?? []).length ? ok("テスト送信先", `${s.testRecipients!.length} 件`) : warn("テスト送信先", "管理画面の設定で登録すると、一斉配信やシナリオのテスト送信ができる"));

  // ---- 公開 URL と署名鍵 ----
  out.push(
    /^https:\/\//.test(ctx.publicBaseUrl) ? ok("公開 URL", ctx.publicBaseUrl) : fail("公開 URL", `https で始まっていない：${ctx.publicBaseUrl}（配信停止ヘッダーに https が必要）`),
  );
  out.push(ctx.secret.length >= 32 && !ctx.secret.startsWith("local-development") ? ok("署名用の鍵", "設定済み") : fail("署名用の鍵", "TOKEN_SECRET が未設定か、開発用の値のまま"));
  out.push(ctx.admin ? ok("管理画面のログイン情報", "設定済み") : warn("管理画面のログイン情報", "pnpm tsuzuri admin:setup で設定する"));

  // ---- フォーム（ダブルオプトインとプライバシーポリシー） ----
  const forms = await ctx.db.query<{ slug: string; privacy_url: string | null; confirm_body_markdown: string; double_optin: boolean }>(
    "SELECT slug, privacy_url, confirm_body_markdown, double_optin FROM forms WHERE active",
  );
  if (forms.length === 0) out.push(warn("登録フォーム", "受付中のフォームがない"));
  for (const f of forms) {
    const hasConfirm = /%(confirm|登録確認)(\|[^%]*)?%/.test(f.confirm_body_markdown);
    const privacy = f.privacy_url ?? env.PRIVACY_URL;
    const mode = f.double_optin ? "ダブルオプトイン" : "シングルオプトイン（送信で登録完了）";
    if (f.double_optin && !hasConfirm) out.push(fail(`フォーム ${f.slug}`, "確認メールに %confirm% が無い（ダブルオプトインにならない）"));
    else if (!privacy) out.push(warn(`フォーム ${f.slug}`, `${mode}。プライバシーポリシーの URL が未設定`));
    else out.push(ok(`フォーム ${f.slug}`, `${mode}・プライバシーポリシーあり`));
  }

  // ---- 長期間反応のない読者への対応（休眠者の再確認） ----
  const [re] = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM sequences WHERE purpose = 'reengage' AND status = 'active'");
  out.push((re?.n ?? 0) > 0 ? ok("休眠者の再確認シナリオ", "有効") : warn("休眠者の再確認シナリオ", "有効なものが無い（休眠者は一斉配信から外れるが、再確認と自動停止は動かない）"));

  // ---- 送信待ちの滞留 ----
  const [stuck] = await ctx.db.query<{ failed: number; waiting: number }>(
    `SELECT count(*) FILTER (WHERE status = 'failed' AND queued_at > now() - interval '7 days')::int AS failed,
            count(*) FILTER (WHERE status = 'queued' AND error IS NOT NULL)::int AS waiting FROM messages`,
  );
  out.push(
    (stuck?.failed ?? 0) + (stuck?.waiting ?? 0) === 0
      ? ok("送信エラー", "直近 7 日の失敗・再試行待ちなし")
      : warn("送信エラー", `失敗 ${stuck?.failed ?? 0} 通、再試行待ち ${stuck?.waiting ?? 0} 通（管理画面の配信ログで確認）`),
  );

  // ---- SES ----
  if (!opts.ses) {
    out.push(skip("SES", "AWS の認証情報が無いため確認しなかった"));
  } else {
    const ses = opts.ses;
    // 既定の送信ドメインと、管理画面で追加した送信ドメイン（シナリオ・一斉配信ごとの送信元）
    for (const d of [domain, ...(s.sendingDomains ?? []).filter((x) => x !== domain)]) {
      try {
        const id = (await ses.send(new GetEmailIdentityCommand({ EmailIdentity: d }))) as {
          VerifiedForSendingStatus?: boolean;
          DkimAttributes?: { Status?: string };
          MailFromAttributes?: { MailFromDomainStatus?: string };
        };
        const dkim = id.DkimAttributes?.Status;
        const mf = id.MailFromAttributes?.MailFromDomainStatus;
        out.push(
          id.VerifiedForSendingStatus && dkim === "SUCCESS" && mf === "SUCCESS"
            ? ok(`SES の ID ${d}`, "検証済み（DKIM・MAIL FROM とも成功）")
            : fail(`SES の ID ${d}`, `送信可=${String(id.VerifiedForSendingStatus)}、DKIM=${dkim ?? "?"}、MAIL FROM=${mf ?? "?"}`),
        );
      } catch (e) {
        out.push(fail(`SES の ID ${d}`, e instanceof Error ? e.message : String(e)));
      }
    }
    try {
      const acc = (await ses.send(new GetAccountCommand({}))) as {
        ProductionAccessEnabled?: boolean;
        SendQuota?: { Max24HourSend?: number; MaxSendRate?: number };
        SuppressionAttributes?: { SuppressedReasons?: string[] };
      };
      const reasons = acc.SuppressionAttributes?.SuppressedReasons ?? [];
      out.push(
        reasons.includes("BOUNCE") && reasons.includes("COMPLAINT")
          ? ok("アカウントの抑制リスト", "BOUNCE・COMPLAINT")
          : fail("アカウントの抑制リスト", `有効な理由：${reasons.join(",") || "なし"}（put-account-suppression-attributes で有効にする）`),
      );
      const q = acc.SendQuota;
      out.push(
        acc.ProductionAccessEnabled
          ? ok("本番アクセス", `承認済み（24 時間 ${q?.Max24HourSend ?? "?"} 通、${q?.MaxSendRate ?? "?"} 通/秒）`)
          : warn("本番アクセス", `サンドボックス中（24 時間 ${q?.Max24HourSend ?? "?"} 通、${q?.MaxSendRate ?? "?"} 通/秒）`),
      );
      const rate = Number(env.MAX_SEND_RATE ?? 1);
      if (q?.MaxSendRate && rate > q.MaxSendRate) out.push(fail("送信レート", `MAX_SEND_RATE=${rate} が SES の上限 ${q.MaxSendRate} を超えている`));
    } catch (e) {
      out.push(fail("SES のアカウント", e instanceof Error ? e.message : String(e)));
    }
    const cs = opts.configurationSet ?? "tsuzuri";
    try {
      const set = (await ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: cs }))) as {
        SuppressionOptions?: { SuppressedReasons?: string[] };
      };
      const ev = (await ses.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: cs }))) as {
        EventDestinations?: { Enabled?: boolean; MatchingEventTypes?: string[] }[];
      };
      const types = new Set((ev.EventDestinations ?? []).filter((d) => d.Enabled !== false).flatMap((d) => d.MatchingEventTypes ?? []));
      out.push(
        types.has("BOUNCE") && types.has("COMPLAINT")
          ? ok(`設定セット ${cs}`, `イベント：${[...types].join(",")}、抑制：${(set.SuppressionOptions?.SuppressedReasons ?? []).join(",") || "なし"}`)
          : fail(`設定セット ${cs}`, "バウンス・苦情のイベント送信先が無い（infra/ をデプロイする）"),
      );
    } catch (e) {
      out.push(fail(`設定セット ${cs}`, e instanceof Error ? e.message : String(e)));
    }
  }
  out.push(env.SES_EVENTS_QUEUE_URL || env.AWS_LAMBDA_FUNCTION_NAME ? ok("バウンス・苦情の受け取り", "設定済み") : warn("バウンス・苦情の受け取り", "SES_EVENTS_QUEUE_URL が未設定（VPS では必須）"));

  // ---- 公開ページ ----
  if (opts.checkHttp) {
    const f = opts.fetch ?? fetch;
    try {
      const health = await f(`${ctx.publicBaseUrl}/health`);
      out.push(health.ok ? ok("公開ページ /health", "応答あり") : fail("公開ページ /health", `HTTP ${health.status}`));
      const legal = await f(`${ctx.publicBaseUrl}/legal`);
      const csp = legal.headers.get("content-security-policy");
      out.push(legal.ok && csp ? ok("送信者情報ページ /legal", "表示できる・セキュリティヘッダーあり") : warn("送信者情報ページ /legal", `HTTP ${legal.status}`));
    } catch (e) {
      out.push(fail("公開ページ", e instanceof Error ? e.message : String(e)));
    }
  }
  return out;
}

export function formatDoctor(results: CheckResult[]): string {
  const mark: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  const lines = results.map((r) => `${mark[r.status]} ${r.name}：${r.detail}`);
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push("", fails ? `✗ が ${fails} 件あります。申請の前に直してください。` : warns ? `! が ${warns} 件あります（申請前に確認を推奨）。` : "すべて問題ありません。");
  return lines.join("\n");
}

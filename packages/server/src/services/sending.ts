import {
  createToken,
  listUnsubscribeHeaders,
  resolveSender,
  type BodyFormat,
  type SenderOverride,
  renderEmail,
  validateTemplate,
  type PlaceholderContext,
} from "@tsuzuri/core";
import { linkUrl, missingLegalFields, senderInfoUrl, url, type AppContext } from "../context.js";
import { formatJstDate } from "../time.js";
import { PRODUCT_ENTITLED_SQL } from "./entitlements.js";
import { footerBody } from "./footers.js";
import { confirmToken } from "./subscription.js";
import { listCustomVariables } from "./variables.js";

export const MAX_ATTEMPTS = 3;

export type SendOutcome = "sent" | "skipped" | "not-queued" | "failed" | "retry";

interface Claimed {
  id: string;
  kind: "sequence" | "broadcast" | "optin";
  contact_id: string;
  channel_id: string;
  step_id: string | null;
  broadcast_id: string | null;
  form_id: string | null;
  enrollment_id: string | null;
  attempts: number;
  variant: "a" | "b" | null;
}

interface Content {
  subject: string;
  body: string;
  format: BodyFormat;
  formId: string | null;
  allowPaused: boolean;
  /** 一斉配信・シナリオで選んだフッター（NULL なら既定のフッター） */
  footerId: string | null;
  /** シナリオ・一斉配信ごとの送信者（空欄の項目は全体の設定） */
  sender: SenderOverride | null;
  /** 商品のシナリオなら、そのシナリオの id と商品の id（特典は商品のファイルを配る） */
  product?: { sequenceId: string; productId: string | null };
}

const SENDER_COLUMNS = "from_name AS \"fromName\", from_address AS \"fromAddress\", reply_to AS \"replyTo\"";

async function loadContent(ctx: AppContext, m: Claimed): Promise<Content | undefined> {
  if (m.kind === "optin") {
    // 確認メールは、フォームが始めるシナリオの送信者で送る（読者から見て送信者がそろうように）
    const [f] = await ctx.db.query<{ confirm_subject: string; confirm_body_markdown: string; confirm_body_format: BodyFormat } & SenderOverride>(
      `SELECT f.confirm_subject, f.confirm_body_markdown, f.confirm_body_format,
              s.from_name AS "fromName", s.from_address AS "fromAddress", s.reply_to AS "replyTo"
         FROM forms f LEFT JOIN sequences s ON s.id = f.sequence_id WHERE f.id = $1`,
      [m.form_id],
    );
    return (
      f && {
        subject: f.confirm_subject,
        body: f.confirm_body_markdown,
        format: f.confirm_body_format,
        formId: m.form_id,
        allowPaused: false,
        footerId: null,
        sender: { fromName: f.fromName ?? null, fromAddress: f.fromAddress ?? null, replyTo: f.replyTo ?? null },
      }
    );
  }
  if (m.kind === "sequence") {
    const [s] = await ctx.db.query<{
      subject: string | null;
      body_markdown: string;
      body_format: BodyFormat;
      sequence_id: string;
      purpose: string;
      footer_id: string | null;
    } & SenderOverride>(
      `SELECT st.subject, st.body_markdown, st.body_format, st.sequence_id, sq.purpose, sq.footer_id,
              sq.from_name AS "fromName", sq.from_address AS "fromAddress", sq.reply_to AS "replyTo"
         FROM sequence_steps st JOIN sequences sq ON sq.id = st.sequence_id WHERE st.id = $1`,
      [m.step_id],
    );
    if (!s) return undefined;
    const [f] = await ctx.db.query<{ id: string }>(
      "SELECT id FROM forms WHERE sequence_id = $1 AND lead_magnet_key IS NOT NULL ORDER BY created_at LIMIT 1",
      [s.sequence_id],
    );
    const [p] =
      s.purpose === "product"
        ? await ctx.db.query<{ id: string }>("SELECT id FROM products WHERE sequence_id = $1 AND delivery_key IS NOT NULL ORDER BY created_at LIMIT 1", [s.sequence_id])
        : [];
    return {
      ...(s.purpose === "product" ? { product: { sequenceId: s.sequence_id, productId: p?.id ?? null } } : {}),
      subject: s.subject ?? "",
      body: s.body_markdown,
      format: s.body_format,
      formId: f?.id ?? null,
      allowPaused: s.purpose === "reengage",
      footerId: s.footer_id,
      sender: { fromName: s.fromName ?? null, fromAddress: s.fromAddress ?? null, replyTo: s.replyTo ?? null },
    };
  }
  const [b] = await ctx.db.query<{ subject: string | null; body_markdown: string; body_format: BodyFormat; footer_id: string | null } & SenderOverride>(
    // 件名の A/B テストで B を受け取る読者には件名 B
    `SELECT CASE WHEN $2::text = 'b' AND subject_b IS NOT NULL THEN subject_b ELSE subject END AS subject, body_markdown, body_format, footer_id, ${SENDER_COLUMNS}
       FROM broadcasts WHERE id = $1`,
    [m.broadcast_id, m.variant],
  );
  return (
    b && {
      subject: b.subject ?? "",
      body: b.body_markdown,
      format: b.body_format,
      formId: null,
      allowPaused: false,
      footerId: b.footer_id,
      sender: { fromName: b.fromName ?? null, fromAddress: b.fromAddress ?? null, replyTo: b.replyTo ?? null },
    }
  );
}

async function finish(ctx: AppContext, id: string, status: string, error?: string): Promise<void> {
  await ctx.db.query("UPDATE messages SET status = $2, error = $3 WHERE id = $1", [id, status, error ?? null]);
}

/**
 * 送信記録を1通送る。SQS の各メッセージから呼ばれる。
 * queued → sending に更新できたときだけ送るので、同じ記録が二度送られることはない。
 */
export async function sendMessage(ctx: AppContext, messageId: string): Promise<SendOutcome> {
  const [m] = await ctx.db.query<Claimed>(
    `UPDATE messages SET status = 'sending', attempts = attempts + 1, last_attempt_at = $2
      WHERE id = $1 AND status = 'queued' AND (send_after IS NULL OR send_after <= $2)
      RETURNING id, kind, contact_id, channel_id, step_id, broadcast_id, form_id, enrollment_id, attempts, variant`,
    [messageId, ctx.now()],
  );
  if (!m) return "not-queued";

  const [who] = await ctx.db.query<{
    status: string;
    display_name: string | null;
    attributes: Record<string, unknown>;
    created_at: Date;
    address: string;
    channel_status: string;
  }>(
    `SELECT c.status, c.display_name, c.attributes, c.created_at, ch.address, ch.status AS channel_status
       FROM contacts c JOIN channels ch ON ch.id = $2 WHERE c.id = $1`,
    [m.contact_id, m.channel_id],
  );
  const content = await loadContent(ctx, m);
  if (!who || !content) {
    await finish(ctx, m.id, "failed", "missing contact or content");
    return "failed";
  }

  // 配信停止・苦情・バウンスはスコアや区分より常に優先する
  // 商品のシナリオは、買った人（受け取る権利がある人）に、配信を停止していない限り届ける
  const entitled =
    content.product && who.status !== "unsubscribed"
      ? (await ctx.db.query(`SELECT 1 WHERE ${PRODUCT_ENTITLED_SQL("$1", "$2")}`, [m.contact_id, content.product.sequenceId])).length > 0
      : false;
  const sendable =
    m.kind === "optin"
      ? who.channel_status === "active" || who.channel_status === "unsubscribed"
      : who.channel_status === "active" && (who.status === "active" || (content.allowPaused && who.status === "paused") || entitled);
  if (!sendable) {
    await finish(ctx, m.id, "skipped", `not sendable: ${who.status}/${who.channel_status}`);
    return "skipped";
  }
  // 配信設定（送信待ちになった後に変えられた場合も守る）。確認メールは対象外
  if (m.kind !== "optin") {
    const [pref] = await ctx.db.query<{ paused: boolean; topic_off: boolean }>(
      `SELECT (c.paused_until IS NOT NULL AND c.paused_until > $2) AS paused,
              COALESCE((SELECT NOT p.subscribed FROM contact_topic_prefs p WHERE p.contact_id = c.id AND p.topic_id = x.topic_id),
                       (SELECT NOT t.default_subscribed FROM topics t WHERE t.id = x.topic_id), false) AS topic_off
         FROM contacts c,
              (SELECT COALESCE((SELECT topic_id FROM broadcasts WHERE id = $3), (SELECT s.topic_id FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id WHERE st.id = $4)) AS topic_id) x
        WHERE c.id = $1`,
      [m.contact_id, ctx.now(), m.broadcast_id, m.step_id],
    );
    if (pref?.paused || pref?.topic_off) {
      await finish(ctx, m.id, "skipped", pref.paused ? "paused by reader" : "topic opted out");
      return "skipped";
    }
  }

  // 法定表示（送信者名・住所・問い合わせ先）が揃っていなければ送らない
  const missing = missingLegalFields(ctx.settings);
  if (missing.length > 0) {
    await finish(ctx, m.id, "queued", `settings incomplete: ${missing.join(", ")}`);
    return "retry";
  }

  const custom = await listCustomVariables(ctx.db);
  const keys = custom.map((c) => c.key);
  const unknown = [...new Set([...validateTemplate(content.subject, keys).unknown, ...validateTemplate(content.body, keys, { html: content.format === "html" }).unknown])];
  if (unknown.length > 0) {
    await finish(ctx, m.id, "failed", `unknown placeholders: ${unknown.join(",")}`);
    return "failed";
  }

  const s = ctx.settings;
  const unsubscribeToken = createToken("unsubscribe", m.contact_id, ctx.secret);
  // 本文のリンクは LINK_BASE_URL（あれば）、ワンクリック配信停止のヘッダーは常にアプリへ直接（POST を転送させないため）
  const unsubscribeUrl = linkUrl(ctx, `/u/${unsubscribeToken}`);
  const oneClickUnsubscribeUrl = url(ctx, `/u/${unsubscribeToken}`);
  const preferencesUrl = linkUrl(ctx, `/p/${createToken("preferences", m.contact_id, ctx.secret)}`);
  const builtins: Record<string, string> = {
    cancel: unsubscribeUrl,
    settings: preferencesUrl,
    name: who.display_name ?? s.defaultName ?? "",
    email: who.address,
    date: formatJstDate(ctx.now()),
    sender: s.senderName,
    contact: s.contact,
    sender_info: senderInfoUrl(ctx),
    subscribed_date: formatJstDate(new Date(who.created_at)),
  };
  if (m.broadcast_id) {
    builtins.webview = linkUrl(ctx, `/w/${m.broadcast_id}?r=${createToken("read", m.id, ctx.secret)}`);
  }
  if (m.kind === "optin" && m.form_id) builtins.confirm = linkUrl(ctx, `/confirm/${confirmToken(ctx, m.contact_id, m.form_id)}`);
  if (content.product?.productId) {
    builtins.download = linkUrl(ctx, `/d/${createToken("download", `${m.contact_id}/p:${content.product.productId}/${m.id}`, ctx.secret)}`);
  } else if (content.formId) {
    builtins.download = linkUrl(ctx, `/d/${createToken("download", `${m.contact_id}/${content.formId}/${m.id}`, ctx.secret)}`);
  }
  const context: PlaceholderContext = { builtins, custom, attributes: who.attributes ?? {} };

  // 確認メールは計測しない（登録前のため）
  const tracking =
    m.kind === "optin"
      ? undefined
      : {
          clickUrl: (i: number) => linkUrl(ctx, `/c/${createToken("click", `${m.id}/${i}`, ctx.secret)}`),
          openPixelUrl: linkUrl(ctx, `/o/${createToken("open", m.id, ctx.secret)}.gif`),
        };

  const footerTemplate = await footerBody(ctx.db, content.footerId);
  const sender = resolveSender(
    { fromName: s.fromName, fromAddress: s.fromAddress, ...(s.replyTo ? { replyTo: s.replyTo } : {}) },
    content.sender,
  );
  const rendered = renderEmail({
    subject: content.subject,
    body: content.body,
    format: content.format,
    context,
    footer: {
      senderName: s.senderName,
      contact: s.contact,
      senderInfoUrl: senderInfoUrl(ctx),
      ...(s.footerExtraLines ? { extraLines: s.footerExtraLines } : {}),
    },
    unsubscribeUrl,
    preferencesUrl,
    ...(tracking ? { tracking } : {}),
    ...(footerTemplate ? { footerTemplate } : {}),
  });

  try {
    const headers = m.kind === "optin" ? {} : listUnsubscribeHeaders(oneClickUnsubscribeUrl);
    const result = await ctx.provider.send({
      idempotencyKey: m.id,
      to: who.address,
      from: { address: sender.fromAddress, name: sender.fromName },
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers,
      tags: { message_id: m.id, kind: m.kind },
    });
    await ctx.db.query(
      // 件名は置き換え前のひな形を残す（読者ごとの値は残さない。元のシナリオなどを消しても何のメールか分かるように）
      "UPDATE messages SET status = 'sent', sent_at = $2, provider_message_id = $3, links = $4, link_count = $5, subject = $6, error = NULL WHERE id = $1",
      [m.id, ctx.now(), result.providerMessageId, JSON.stringify(rendered.links), rendered.links.length, content.subject],
    );
    return "sent";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (m.attempts < MAX_ATTEMPTS) {
      await finish(ctx, m.id, "queued", msg);
      return "retry";
    }
    await finish(ctx, m.id, "failed", msg);
    return "failed";
  }
}

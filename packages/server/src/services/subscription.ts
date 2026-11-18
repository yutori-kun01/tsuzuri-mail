import { randomUUID } from "node:crypto";
import { createToken, idempotencyKey, verifyToken } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import { enroll } from "./sequences.js";

export function normalizeEmail(raw: string): string | undefined {
  const e = raw.trim().toLowerCase();
  // 実用上の簡易チェック（厳密な RFC 検証はしない）
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return undefined;
  return e;
}

/** 同じアドレスに 24 時間で送る確認メールの上限 */
export const MAX_CONFIRMATIONS_PER_DAY = 3;

export interface SubscribeInput {
  formSlug: string;
  email: string;
  name?: string;
  /** フォームの入力項目の値（読者の属性に入れる）。登録済みの読者の属性は書き換えない */
  attributes?: Record<string, string>;
  /** 登録経路の識別名（フォームの URL の ?r=）。登録されていない識別名は無視する */
  route?: string;
}

/** 受付期間内か（期間の指定がなければ常に期間内）。$n は現在時刻 */
export const FORM_OPEN_SQL = (nowParam: string) =>
  `(accept_from IS NULL OR accept_from <= ${nowParam}) AND (accept_until IS NULL OR accept_until > ${nowParam})`;

export type SubscribeResult =
  | { status: "confirmation-sent"; contactId: string; messageId: string }
  /** シングルオプトインのフォーム：確認メールなしで登録を完了した */
  | { status: "subscribed"; contactId: string; thanksUrl: string | null; confirmedMessage: string | null }
  | { status: "already-active"; contactId: string }
  | { status: "throttled"; contactId: string }
  | { status: "invalid-email" }
  | { status: "form-not-found" };

interface FormRow {
  id: string;
  slug: string;
  tag_id: string | null;
  sequence_id: string | null;
  consent_text_version: string;
}

/**
 * フォームからの登録。
 * - ダブルオプトイン（既定）：確認メールを送信キューに積み、リンクが押されたら登録を完了する。
 * - シングルオプトイン：フォームの送信だけで登録を完了する（同意の記録は同じように残す）。
 *   ただし、配信を停止した人のアドレスで送られたときは、本人以外による再登録を防ぐため確認メールで確かめる。
 * 既に有効な読者なら、確認なしでフォームのタグとシナリオだけ追加する。
 */
export async function subscribe(
  ctx: AppContext,
  input: SubscribeInput,
  opts: {
    /** 管理画面から送るときは、受付を止めているフォームでも使える */
    allowInactiveForm?: boolean;
    /** 本人以外が入力したアドレス（管理画面からの招待）は、フォームの設定にかかわらず確認メールで確かめる */
    requireConfirmation?: boolean;
  } = {},
): Promise<SubscribeResult> {
  const email = normalizeEmail(input.email);
  if (!email) return { status: "invalid-email" };

  return ctx.db.transaction(async (tx) => {
    const [form] = await tx.query<FormRow & { double_optin: boolean; thanks_url: string | null; confirmed_message: string | null }>(
      `SELECT id, slug, tag_id, sequence_id, consent_text_version, double_optin, thanks_url, confirmed_message
         FROM forms WHERE slug = $1 AND ((active AND ${FORM_OPEN_SQL("$3")}) OR $2)`,
      [input.formSlug, opts.allowInactiveForm === true, ctx.now()],
    );
    if (!form) return { status: "form-not-found" } as const;

    const [existing] = await tx.query<{ contact_id: string; channel_id: string; contact_status: string; channel_status: string }>(
      `SELECT ch.contact_id, ch.id AS channel_id, c.status AS contact_status, ch.status AS channel_status
         FROM channels ch JOIN contacts c ON c.id = ch.contact_id
        WHERE ch.kind = 'email' AND ch.address = $1 FOR UPDATE`,
      [email],
    );

    if (existing && existing.contact_status === "active" && existing.channel_status === "active") {
      await applyFormToContact(tx, ctx, form, existing.contact_id);
      return { status: "already-active", contactId: existing.contact_id } as const;
    }
    // 苦情を出したアドレスには、本人の再登録でも自動では送らない
    if (existing?.channel_status === "complained") {
      return { status: "already-active", contactId: existing.contact_id } as const;
    }

    let contactId: string;
    let channelId: string;
    if (existing) {
      contactId = existing.contact_id;
      channelId = existing.channel_id;
      if (input.name) await tx.query("UPDATE contacts SET display_name = COALESCE(display_name, $2) WHERE id = $1", [contactId, input.name]);
      // まだ有効でない読者（確認待ち・停止中）だけ、今回の入力で属性を上書きする
      if (input.attributes && Object.keys(input.attributes).length > 0) {
        await tx.query("UPDATE contacts SET attributes = attributes || $2::jsonb WHERE id = $1", [contactId, JSON.stringify(input.attributes)]);
      }
    } else {
      const [c] = await tx.query<{ id: string }>(
        "INSERT INTO contacts (display_name, source, status, attributes) VALUES ($1, $2, 'pending', $3::jsonb) RETURNING id",
        [input.name ?? null, form.slug, JSON.stringify(input.attributes ?? {})],
      );
      contactId = c!.id;
      const [ch] = await tx.query<{ id: string }>(
        "INSERT INTO channels (contact_id, kind, address, status) VALUES ($1, 'email', $2, 'active') RETURNING id",
        [contactId, email],
      );
      channelId = ch!.id;
    }

    await tx.query(
      `INSERT INTO consents (channel_id, method, form_id, consent_text_version, consented_at, route_id)
       VALUES ($1, 'form', $2, $3, $4, (SELECT id FROM signup_routes WHERE code = $5))`,
      [channelId, form.id, form.consent_text_version, ctx.now(), input.route ?? null],
    );

    // シングルオプトイン：その場で登録を完了する（配信停止した人の再登録だけは確認メールで本人に確かめる）
    const wasUnsubscribed = existing?.contact_status === "unsubscribed" || existing?.channel_status === "unsubscribed";
    if (!form.double_optin && !wasUnsubscribed && opts.requireConfirmation !== true) {
      await activateConsent(tx, ctx, form, contactId);
      return { status: "subscribed", contactId, thanksUrl: form.thanks_url, confirmedMessage: form.confirmed_message } as const;
    }

    // 第三者のアドレスで何度も送信されて確認メールが大量に届くのを防ぐ
    const [recent] = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM messages WHERE kind = 'optin' AND contact_id = $1 AND queued_at > $2",
      [contactId, new Date(ctx.now().getTime() - 24 * 3_600_000)],
    );
    if ((recent?.n ?? 0) >= MAX_CONFIRMATIONS_PER_DAY) return { status: "throttled", contactId } as const;

    // 確認メール。同じフォーム・同じ読者で何度押されても、未送信のものは1通にまとめる
    const key = `${idempotencyKey.confirmation(contactId, form.id)}:${randomUUID()}`;
    const [m] = await tx.query<{ id: string }>(
      `INSERT INTO messages (idempotency_key, contact_id, channel_id, provider, kind, form_id)
       SELECT $1, $2, $3, $4, 'optin', $5
        WHERE NOT EXISTS (SELECT 1 FROM messages WHERE kind = 'optin' AND contact_id = $2 AND form_id = $5 AND status = 'queued')
       RETURNING id`,
      [key, contactId, channelId, ctx.provider.name, form.id],
    );
    const messageId =
      m?.id ??
      (await tx.query<{ id: string }>(
        "SELECT id FROM messages WHERE kind = 'optin' AND contact_id = $1 AND form_id = $2 AND status = 'queued' LIMIT 1",
        [contactId, form.id],
      ))[0]!.id;
    return { status: "confirmation-sent", contactId, messageId } as const;
  });
}

async function applyFormToContact(tx: Db, ctx: AppContext, form: FormRow, contactId: string): Promise<void> {
  if (form.tag_id) {
    await tx.query(
      "INSERT INTO contact_tags (contact_id, tag_id, reason) VALUES ($1, $2, 'form') ON CONFLICT DO NOTHING",
      [contactId, form.tag_id],
    );
  }
  if (form.sequence_id) await enroll(tx, ctx, contactId, form.sequence_id);
}

/** 確認メールのトークン。対象は「contactId/formId」 */
export function confirmToken(ctx: AppContext, contactId: string, formId: string): string {
  return createToken("confirm", `${contactId}/${formId}`, ctx.secret);
}

export type ConfirmResult =
  | { status: "confirmed"; contactId: string; thanksUrl: string | null; confirmedMessage: string | null }
  | { status: "invalid" };

export async function confirm(ctx: AppContext, token: string): Promise<ConfirmResult> {
  const subject = verifyToken(token, "confirm", ctx.secret);
  const [contactId, formId] = subject?.split("/") ?? [];
  if (!contactId || !formId) return { status: "invalid" };

  return ctx.db.transaction(async (tx) => {
    const [form] = await tx.query<FormRow & { thanks_url: string | null; confirmed_message: string | null }>(
      "SELECT id, slug, tag_id, sequence_id, consent_text_version, thanks_url, confirmed_message FROM forms WHERE id = $1",
      [formId],
    );
    const [contact] = await tx.query<{ status: string }>("SELECT status FROM contacts WHERE id = $1 FOR UPDATE", [contactId]);
    if (!form || !contact) return { status: "invalid" } as const;

    await activateConsent(tx, ctx, form, contactId);
    return { status: "confirmed", contactId, thanksUrl: form.thanks_url, confirmedMessage: form.confirmed_message } as const;
  });
}

/** 同意を確定して読者を有効にし、フォームのタグとシナリオを付ける（確認リンク、またはシングルオプトインの送信で呼ぶ） */
async function activateConsent(tx: Db, ctx: AppContext, form: FormRow, contactId: string): Promise<void> {
  const [contact] = await tx.query<{ status: string }>("SELECT status FROM contacts WHERE id = $1 FOR UPDATE", [contactId]);
  const now = ctx.now();
  await tx.query(
    `UPDATE consents SET confirmed_at = $3
      WHERE id = (SELECT co.id FROM consents co JOIN channels ch ON ch.id = co.channel_id
                   WHERE ch.contact_id = $1 AND co.form_id = $2 AND co.confirmed_at IS NULL AND co.revoked_at IS NULL
                   ORDER BY co.consented_at DESC LIMIT 1)`,
    [contactId, form.id, now],
  );
  const wasActive = contact?.status === "active";
  await tx.query("UPDATE contacts SET status = 'active', updated_at = $2 WHERE id = $1", [contactId, now]);
  await tx.query(
    "UPDATE channels SET status = 'active', updated_at = $2 WHERE contact_id = $1 AND kind = 'email' AND status IN ('active','unsubscribed')",
    [contactId, now],
  );
  if (!wasActive) {
    await tx.query("INSERT INTO events (contact_id, type, occurred_at) VALUES ($1, $2, $3)", [
      contactId,
      contact?.status === "unsubscribed" ? "resubscribe" : "subscribe",
      now,
    ]);
  }
  await applyFormToContact(tx, ctx, form, contactId);
}

/** 配信停止。進行中のシナリオも止め、同意を撤回済みにする。 */
export async function unsubscribe(ctx: AppContext, contactId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const rows = await tx.query("UPDATE contacts SET status = 'unsubscribed', updated_at = $2 WHERE id = $1 RETURNING id", [
      contactId,
      now,
    ]);
    if (rows.length === 0) return false;
    await tx.query(
      "UPDATE channels SET status = 'unsubscribed', updated_at = $2 WHERE contact_id = $1 AND status = 'active'",
      [contactId, now],
    );
    await tx.query(
      `UPDATE consents SET revoked_at = $2
        WHERE revoked_at IS NULL AND channel_id IN (SELECT id FROM channels WHERE contact_id = $1)`,
      [contactId, now],
    );
    await tx.query("UPDATE enrollments SET status = 'stopped', updated_at = $2 WHERE contact_id = $1 AND status = 'active'", [
      contactId,
      now,
    ]);
    await tx.query("UPDATE messages SET status = 'skipped', error = 'unsubscribed' WHERE contact_id = $1 AND status = 'queued'", [
      contactId,
    ]);
    await tx.query("INSERT INTO events (contact_id, type, occurred_at) VALUES ($1, 'unsubscribe', $2)", [contactId, now]);
    return true;
  });
}

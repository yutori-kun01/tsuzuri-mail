import type { AppContext } from "../context.js";
import type { Db } from "../db.js";
import { enroll } from "./sequences.js";
import { normalizeEmail, subscribe } from "./subscription.js";

/** 管理画面からの 1 件ずつの登録（同意を得ている人を、運営者が手で登録する） */
export interface ManualAddInput {
  email: string;
  name?: string;
  /** どう同意を得たか（必須。同意記録として保存） */
  evidence: string;
  /** 同意した日（無ければ今） */
  consentedAt?: Date;
  tags?: string[];
  /** 登録後に始めるシナリオ（任意） */
  sequenceId?: string;
}

export type ManualAddResult =
  | { status: "added"; contactId: string; enrolled: boolean }
  | { status: "updated"; contactId: string; enrolled: boolean }
  | { status: "invalid-email" }
  | { status: "blocked"; contactId: string; reason: string };

const BLOCKED_REASON: Record<string, string> = {
  unsubscribed: "配信停止した読者です",
  complained: "迷惑メールとして報告した読者です",
  bounced: "メールが届かなかった（不達の）アドレスです",
  blocked: "送信を止めているアドレスです",
  stopped: "配信を止めた読者です",
};

async function tagId(tx: Db, name: string): Promise<string> {
  const [t] = await tx.query<{ id: string }>(
    "INSERT INTO tags (name, category) VALUES ($1, 'cust') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [name],
  );
  return t!.id;
}

/**
 * 同意済みとして登録する。
 * - 新しいアドレス：配信中（active）で登録し、同意の記録・タグ・シナリオを付ける
 * - 仮登録（確認メール待ち）の読者：運営者が同意を確認したものとして配信中にする
 * - 配信中の読者：タグとシナリオだけ足す（状態は変えない）
 * - 配信停止・苦情・不達の読者：変えない（本人の意思や配信の安全を優先する）
 */
export async function addContactManually(ctx: AppContext, input: ManualAddInput): Promise<ManualAddResult> {
  const email = normalizeEmail(input.email);
  if (!email) return { status: "invalid-email" };
  const name = input.name?.trim().slice(0, 40) || null;
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter((t) => t && t.length <= 40))];
  const consentedAt = input.consentedAt ?? ctx.now();

  return ctx.db.transaction(async (tx) => {
    const [existing] = await tx.query<{ contact_id: string; channel_id: string; contact_status: string; channel_status: string }>(
      `SELECT ch.contact_id, ch.id AS channel_id, c.status AS contact_status, ch.status AS channel_status
         FROM channels ch JOIN contacts c ON c.id = ch.contact_id
        WHERE ch.kind = 'email' AND ch.address = $1 FOR UPDATE`,
      [email],
    );
    if (existing) {
      const reason = BLOCKED_REASON[existing.channel_status] ?? BLOCKED_REASON[existing.contact_status];
      if (reason) return { status: "blocked", contactId: existing.contact_id, reason } as const;
    }

    let contactId: string;
    let status: "added" | "updated";
    if (existing) {
      contactId = existing.contact_id;
      status = "updated";
      if (existing.contact_status === "pending") {
        await tx.query("UPDATE contacts SET status = 'active', updated_at = now() WHERE id = $1", [contactId]);
        await recordConsent(tx, existing.channel_id, input.evidence, consentedAt);
      }
      if (name) await tx.query("UPDATE contacts SET display_name = COALESCE(display_name, $2) WHERE id = $1", [contactId, name]);
    } else {
      const [c] = await tx.query<{ id: string }>(
        "INSERT INTO contacts (display_name, source, status) VALUES ($1, 'manual', 'active') RETURNING id",
        [name],
      );
      contactId = c!.id;
      const [ch] = await tx.query<{ id: string }>(
        "INSERT INTO channels (contact_id, kind, address, status) VALUES ($1, 'email', $2, 'active') RETURNING id",
        [contactId, email],
      );
      await recordConsent(tx, ch!.id, input.evidence, consentedAt);
      status = "added";
    }

    for (const t of tags) {
      await tx.query("INSERT INTO contact_tags (contact_id, tag_id, reason) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING", [
        contactId,
        await tagId(tx, t),
      ]);
    }
    const enrolled = input.sequenceId ? Boolean(await enroll(tx, ctx, contactId, input.sequenceId)) : false;
    return { status, contactId, enrolled } as const;
  });
}

async function recordConsent(tx: Db, channelId: string, evidence: string, at: Date): Promise<void> {
  await tx.query(
    `INSERT INTO consents (channel_id, method, consent_text_version, evidence, consented_at, confirmed_at)
     VALUES ($1, 'manual', 'manual', $2, $3, $3)`,
    [channelId, JSON.stringify({ evidence }), at],
  );
}

/**
 * 本人に確認メールを送って登録してもらう（ダブルオプトイン）。
 * 選んだフォームの確認メール・タグ・シナリオ・特典がそのまま使われる。フォームの受付が止まっていても使える。
 */
export async function inviteByForm(ctx: AppContext, formId: string, email: string, name?: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { status: "invalid-email" } as const;
  const [form] = await ctx.db.query<{ slug: string }>("SELECT slug FROM forms WHERE id::text = $1", [formId]);
  if (!form) return { status: "form-not-found" } as const;
  // 配信停止・苦情・不達の人には、運営者の操作では確認メールも送らない（本人がフォームから登録し直すのは可）
  const [existing] = await ctx.db.query<{ contact_id: string; contact_status: string; channel_status: string }>(
    `SELECT ch.contact_id, c.status AS contact_status, ch.status AS channel_status
       FROM channels ch JOIN contacts c ON c.id = ch.contact_id WHERE ch.kind = 'email' AND ch.address = $1`,
    [normalized],
  );
  const reason = existing && (BLOCKED_REASON[existing.channel_status] ?? BLOCKED_REASON[existing.contact_status]);
  if (existing && reason) return { status: "blocked", contactId: existing.contact_id, reason } as const;
  return subscribe(ctx, { formSlug: form.slug, email: normalized, ...(name ? { name } : {}) }, { allowInactiveForm: true, requireConfirmation: true });
}

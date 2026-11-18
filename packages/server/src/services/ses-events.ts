import type { AppContext } from "../context.js";

/** ソフトバウンスが何回続いたら一時停止するか */
export const SOFT_BOUNCE_LIMIT = 3;

/**
 * SES の配信イベント（設定セット → SNS → Lambda）。
 * イベント発行の形式（eventType）と、ID 通知の形式（notificationType）の両方を受け付ける。
 */
export interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string };
}

export type SesEventOutcome = "delivered" | "hard-bounce" | "soft-bounce" | "complaint" | "ignored" | "unknown-message";

export async function handleSesEvent(ctx: AppContext, event: SesEvent): Promise<SesEventOutcome> {
  const type = event.eventType ?? event.notificationType;
  const tagged = event.mail?.tags?.message_id?.[0];
  const providerId = event.mail?.messageId;
  const [m] = await ctx.db.query<{ id: string; contact_id: string; channel_id: string }>(
    "SELECT id, contact_id, channel_id FROM messages WHERE id::text = $1 OR provider_message_id = $2 LIMIT 1",
    [tagged ?? "", providerId ?? ""],
  );
  if (!m) return "unknown-message";
  const now = ctx.now();

  return ctx.db.transaction(async (tx) => {
    switch (type) {
      case "Delivery": {
        await tx.query("UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'", [m.id]);
        await tx.query("UPDATE channels SET soft_bounce_streak = 0 WHERE id = $1", [m.channel_id]);
        await tx.query("INSERT INTO events (contact_id, message_id, type, occurred_at) VALUES ($1, $2, 'delivered', $3)", [
          m.contact_id,
          m.id,
          now,
        ]);
        return "delivered";
      }
      case "Bounce": {
        const permanent = event.bounce?.bounceType === "Permanent";
        await tx.query("UPDATE messages SET status = 'bounced' WHERE id = $1", [m.id]);
        await tx.query("INSERT INTO events (contact_id, message_id, type, data, occurred_at) VALUES ($1, $2, 'bounce', $3, $4)", [
          m.contact_id,
          m.id,
          JSON.stringify({ bounceType: event.bounce?.bounceType ?? null }),
          now,
        ]);
        if (permanent) {
          await tx.query("UPDATE channels SET status = 'bounced', updated_at = $2 WHERE id = $1", [m.channel_id, now]);
          await stopEverything(tx, m.contact_id, now, "stopped");
          return "hard-bounce";
        }
        const [ch] = await tx.query<{ soft_bounce_streak: number }>(
          "UPDATE channels SET soft_bounce_streak = soft_bounce_streak + 1, updated_at = $2 WHERE id = $1 RETURNING soft_bounce_streak",
          [m.channel_id, now],
        );
        if ((ch?.soft_bounce_streak ?? 0) >= SOFT_BOUNCE_LIMIT) {
          await tx.query("UPDATE contacts SET status = 'paused', updated_at = $2 WHERE id = $1 AND status = 'active'", [
            m.contact_id,
            now,
          ]);
        }
        return "soft-bounce";
      }
      case "Complaint": {
        await tx.query("UPDATE messages SET status = 'complained' WHERE id = $1", [m.id]);
        await tx.query("UPDATE channels SET status = 'complained', updated_at = $2 WHERE id = $1", [m.channel_id, now]);
        await tx.query("INSERT INTO events (contact_id, message_id, type, occurred_at) VALUES ($1, $2, 'complaint', $3)", [
          m.contact_id,
          m.id,
          now,
        ]);
        await stopEverything(tx, m.contact_id, now, "unsubscribed");
        return "complaint";
      }
      default:
        return "ignored";
    }
  });
}

async function stopEverything(
  tx: Pick<AppContext["db"], "query">,
  contactId: string,
  now: Date,
  status: "stopped" | "unsubscribed",
): Promise<void> {
  await tx.query("UPDATE contacts SET status = $2, updated_at = $3 WHERE id = $1", [contactId, status, now]);
  await tx.query("UPDATE enrollments SET status = 'stopped', updated_at = $2 WHERE contact_id = $1 AND status = 'active'", [
    contactId,
    now,
  ]);
  await tx.query("UPDATE messages SET status = 'skipped', error = $2 WHERE contact_id = $1 AND status = 'queued'", [
    contactId,
    status,
  ]);
}

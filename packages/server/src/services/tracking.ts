import { botClickReason, defaultFilterSettings, isLikelyMachineOpen, verifyToken, type TrackedLink } from "@tsuzuri/core";
import type { AppContext } from "../context.js";
import type { Db } from "../db.js";

export interface RequestInfo {
  method: string;
  userAgent: string | undefined;
}

/** 人間の反応を記録したときの共通処理：未反応数のリセットと、停止中の自動復帰 */
async function markResponded(tx: Db, contactId: string, messageId: string | null, now: Date): Promise<void> {
  if (messageId) await tx.query("UPDATE messages SET responded = true WHERE id = $1", [messageId]);
  await tx.query("UPDATE contacts SET no_response_streak = 0, updated_at = $2 WHERE id = $1", [contactId, now]);
  // 再確認で止めた読者が戻ってきたら通常配信に戻す（配信停止・苦情は戻さない）
  await tx.query(
    "UPDATE contacts SET status = 'active', tier = 'low' WHERE id = $1 AND status IN ('stopped','paused') AND tier = 'dormant'",
    [contactId],
  );
}

/** クリック計測。転送先 URL を返す（不正なトークンなら undefined）。 */
export async function recordClick(ctx: AppContext, token: string, req: RequestInfo): Promise<string | undefined> {
  const subject = verifyToken(token, "click", ctx.secret);
  const [messageId, indexStr] = subject?.split("/") ?? [];
  const index = Number(indexStr);
  if (!messageId || !Number.isInteger(index)) return undefined;

  const [m] = await ctx.db.query<{ contact_id: string; links: TrackedLink[]; sent_at: Date | null; link_count: number }>(
    "SELECT contact_id, links, sent_at, link_count FROM messages WHERE id = $1",
    [messageId],
  );
  const link = m?.links.find((l) => l.index === index);
  if (!m || !link) return undefined;
  const now = ctx.now();

  await ctx.db.transaction(async (tx) => {
    const windowStart = new Date(now.getTime() - defaultFilterSettings.burstWindowMs);
    const [burst] = await tx.query<{ n: number }>(
      `SELECT count(DISTINCT data->>'index')::int AS n FROM events
        WHERE message_id = $1 AND type = 'click' AND occurred_at >= $2 AND (data->>'index') <> $3`,
      [messageId, windowStart, String(index)],
    );
    const reason = botClickReason({
      method: req.method,
      userAgent: req.userAgent,
      deliveredAt: m.sent_at ? new Date(m.sent_at) : now,
      clickedAt: now,
      linksInMessage: m.link_count,
      distinctLinksClickedInBurst: (burst?.n ?? 0) + 1,
    });
    await tx.query(
      "INSERT INTO events (contact_id, message_id, type, bot_reason, data, occurred_at) VALUES ($1, $2, 'click', $3, $4, $5)",
      [m.contact_id, messageId, reason ?? null, JSON.stringify({ index, url: link.url }), now],
    );
    if (!reason) {
      if (link.isLast) {
        await tx.query("INSERT INTO events (contact_id, message_id, type, data, occurred_at) VALUES ($1, $2, 'read', $3, $4)", [
          m.contact_id,
          messageId,
          JSON.stringify({ via: "last-link" }),
          now,
        ]);
      }
      await markResponded(tx, m.contact_id, messageId, now);
    }
  });
  return link.url;
}

/** 開封計測。トークンが不正でも画像は返す（呼び出し側）。 */
export async function recordOpen(ctx: AppContext, token: string, req: RequestInfo): Promise<void> {
  const messageId = verifyToken(token, "open", ctx.secret);
  if (!messageId) return;
  const [m] = await ctx.db.query<{ contact_id: string; sent_at: Date | null }>(
    "SELECT contact_id, sent_at FROM messages WHERE id = $1",
    [messageId],
  );
  if (!m) return;
  const now = ctx.now();
  const machine = isLikelyMachineOpen({
    userAgent: req.userAgent,
    deliveredAt: m.sent_at ? new Date(m.sent_at) : now,
    openedAt: now,
  });
  await ctx.db.query("INSERT INTO events (contact_id, message_id, type, machine, occurred_at) VALUES ($1, $2, 'open', $3, $4)", [
    m.contact_id,
    messageId,
    machine,
    now,
  ]);
}

/** 特典ダウンロード。目標行動として記録し、ファイルの一時 URL を返す。 */
export async function recordDownload(ctx: AppContext, token: string, req: RequestInfo): Promise<string | undefined> {
  const subject = verifyToken(token, "download", ctx.secret);
  const [contactId, formId, messageId] = subject?.split("/") ?? [];
  if (!contactId || !formId || !ctx.storage) return undefined;
  // 商品のファイル（p:<商品の id>）は、受け取る権利がある間だけ配る（全額返金で止まる）
  const productId = formId.startsWith("p:") ? formId.slice(2) : undefined;
  const [f] = productId
    ? await ctx.db.query<{ lead_magnet_key: string | null }>(
        `SELECT p.delivery_key AS lead_magnet_key FROM products p
          WHERE p.id::text = $1 AND EXISTS (SELECT 1 FROM entitlements en WHERE en.product_id = p.id AND en.contact_id::text = $2 AND en.revoked_at IS NULL)`,
        [productId, contactId],
      )
    : await ctx.db.query<{ lead_magnet_key: string | null }>("SELECT lead_magnet_key FROM forms WHERE id = $1", [formId]);
  if (!f?.lead_magnet_key) return undefined;
  const now = ctx.now();
  if (req.method.toUpperCase() !== "HEAD") {
    await ctx.db.transaction(async (tx) => {
      await tx.query("INSERT INTO events (contact_id, message_id, type, data, occurred_at) VALUES ($1, $2, 'goal', $3, $4)", [
        contactId,
        messageId ?? null,
        JSON.stringify(productId ? { goal: "download", productId } : { goal: "download", formId }),
        now,
      ]);
      await markResponded(tx, contactId, messageId ?? null, now);
    });
  }
  return ctx.storage.downloadUrl(f.lead_magnet_key);
}

/** Web 版で末尾まで読まれた（ページ側のスクリプトから呼ばれる）。1通につき1回だけ記録する。 */
export async function recordRead(ctx: AppContext, token: string): Promise<boolean> {
  const messageId = verifyToken(token, "read", ctx.secret);
  if (!messageId) return false;
  const [m] = await ctx.db.query<{ contact_id: string }>("SELECT contact_id FROM messages WHERE id = $1", [messageId]);
  if (!m) return false;
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const exists = await tx.query("SELECT 1 FROM events WHERE message_id = $1 AND type = 'read' LIMIT 1", [messageId]);
    if (exists.length > 0) return false;
    await tx.query("INSERT INTO events (contact_id, message_id, type, data, occurred_at) VALUES ($1, $2, 'read', $3, $4)", [
      m.contact_id,
      messageId,
      JSON.stringify({ via: "webview" }),
      now,
    ]);
    await markResponded(tx, m.contact_id, messageId, now);
    return true;
  });
}

/** キューに積み損ねた送信記録を拾い直す（sendMessage 側で二重送信は防がれる） */
export async function staleQueuedMessages(ctx: AppContext, olderThanMinutes = 2, limit = 500): Promise<string[]> {
  const edge = new Date(ctx.now().getTime() - olderThanMinutes * 60_000);
  const rows = await ctx.db.query<{ id: string }>(
    "SELECT id FROM messages WHERE status = 'queued' AND queued_at < $1 AND (send_after IS NULL OR send_after <= $3) ORDER BY queued_at LIMIT $2",
    [edge, limit, ctx.now()],
  );
  return rows.map((r) => r.id);
}

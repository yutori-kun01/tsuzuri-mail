import type { AppContext } from "../context.js";

/** 失敗したメールを再試行するまでの間隔（試行回数 × この分数） */
export const RETRY_BACKOFF_MINUTES = 2;

/**
 * 送信してよい「送信待ち」のメールを古い順に返す。
 * 一度失敗したものは、試行回数に応じて間隔を空けてから拾う（失敗し続けるメールで詰まらないように）。
 */
export async function dueQueuedMessages(ctx: AppContext, limit = 50): Promise<string[]> {
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM messages
      WHERE status = 'queued'
        AND (send_after IS NULL OR send_after <= $1)
        AND (last_attempt_at IS NULL OR last_attempt_at < $1::timestamptz - ($2::int * attempts) * interval '1 minute')
      ORDER BY queued_at LIMIT $3`,
    [ctx.now(), RETRY_BACKOFF_MINUTES, limit],
  );
  return rows.map((r) => r.id);
}

/** 「送信中」のまま止まったメール（送信途中でプロセスが落ちた等）を数える。自動では再送しない（二重送信を避けるため） */
export async function stuckSendingCount(ctx: AppContext, olderThanMinutes = 10): Promise<number> {
  const [r] = await ctx.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM messages WHERE status = 'sending' AND last_attempt_at < $1",
    [new Date(ctx.now().getTime() - olderThanMinutes * 60_000)],
  );
  return r?.n ?? 0;
}

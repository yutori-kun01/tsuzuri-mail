/**
 * ワンクリック配信停止ヘッダー（RFC 8058）。
 * List-Unsubscribe には HTTPS の URL を必ず含め、List-Unsubscribe-Post を付ける。
 */
export function listUnsubscribeHeaders(httpsUrl: string, mailto?: string): Record<string, string> {
  // 本番は https 必須。ローカル開発（localhost）だけ http を許す
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(httpsUrl);
  if (!httpsUrl.startsWith("https://") && !local) {
    throw new Error("List-Unsubscribe URL must be https");
  }
  const parts = [`<${httpsUrl}>`];
  if (mailto) parts.push(`<mailto:${mailto}>`);
  return {
    "List-Unsubscribe": parts.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** 送信記録の一意キー。DB の一意制約と組み合わせて二重送信を防ぐ。 */
export const idempotencyKey = {
  sequenceStep: (enrollmentId: string, stepId: string) => `seq:${enrollmentId}:${stepId}`,
  broadcast: (broadcastId: string, contactId: string) => `bc:${broadcastId}:${contactId}`,
  confirmation: (contactId: string, formId: string) => `optin:${formId}:${contactId}`,
};

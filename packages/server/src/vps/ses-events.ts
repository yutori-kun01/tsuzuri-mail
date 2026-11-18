import type { SesEvent } from "../services/ses-events.js";

/**
 * SQS のメッセージ本文から SES のイベントを取り出す。
 * SNS → SQS の購読は、既定では SNS の封筒（{"Type":"Notification","Message":"..."}）に包まれて届く。
 * 「raw message delivery」を有効にしている場合は SES のイベントがそのまま届く。どちらにも対応する。
 */
export function parseSesEventBody(body: string): SesEvent | undefined {
  let outer: unknown;
  try {
    outer = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!outer || typeof outer !== "object") return undefined;
  const o = outer as Record<string, unknown>;
  if (o.Type === "Notification" && typeof o.Message === "string") {
    try {
      return JSON.parse(o.Message) as SesEvent;
    } catch {
      return undefined;
    }
  }
  if ("eventType" in o || "notificationType" in o) return o as SesEvent;
  return undefined;
}

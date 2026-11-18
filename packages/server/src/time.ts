/** 日本時間（UTC+9、夏時間なし）での日付計算。 */
const JST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 次の送信時刻。
 * - sendTime なし：base から delayDays 日後のちょうど同じ時刻
 * - sendTime あり（"HH:MM" または "HH:MM:SS"、日本時間）：base の日本時間の日付 + delayDays 日のその時刻。
 *   それが base より前になる場合（当日の指定時刻を過ぎている）は翌日の同時刻
 */
export function nextSendAt(base: Date, delayDays: number, sendTime: string | null | undefined): Date {
  if (!sendTime) return new Date(base.getTime() + delayDays * DAY_MS);
  const [h, m, s] = sendTime.split(":").map(Number);
  const jst = new Date(base.getTime() + JST_OFFSET_MS);
  const dayStartUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - JST_OFFSET_MS;
  let t = dayStartUtc + delayDays * DAY_MS + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
  if (t < base.getTime()) t += DAY_MS;
  return new Date(t);
}

/** ステップの送るタイミング */
export interface StepTiming {
  delay_days: number;
  send_time: string | null | undefined;
  /** NULL でなければ「base から○分後」（0 = すぐ）。delay_days・send_time より優先 */
  delay_minutes?: number | null;
}

/** 前の通（1 通目は登録）の時刻 base から、このステップを送る時刻 */
export function stepSendAt(base: Date, s: StepTiming): Date {
  if (s.delay_minutes !== null && s.delay_minutes !== undefined) return new Date(base.getTime() + s.delay_minutes * 60_000);
  return nextSendAt(base, s.delay_days, s.send_time);
}

/** 画面に出す言い方（例：「すぐ」「3 時間後」「2 日後 8:00」） */
export function describeTiming(s: StepTiming, first: boolean): string {
  const from = first ? "登録から" : "前の通から";
  if (s.delay_minutes !== null && s.delay_minutes !== undefined) {
    if (s.delay_minutes === 0) return first ? "登録後すぐ" : "前の通のすぐ後";
    const h = Math.floor(s.delay_minutes / 60);
    const m = s.delay_minutes % 60;
    return `${from} ${[h ? `${h} 時間` : "", m ? `${m} 分` : ""].filter(Boolean).join(" ")}後`;
  }
  const time = s.send_time ? ` ${s.send_time.slice(0, 5)}` : "";
  if (s.delay_days === 0) return s.send_time ? `${from}同じ日（過ぎていれば翌日）の${time.trim()}` : first ? "登録後すぐ" : "前の通のすぐ後";
  return `${from} ${s.delay_days} 日後${time}`;
}

/** 「2026年11月13日」形式 */
export function formatJstDate(d: Date): string {
  const jst = new Date(d.getTime() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;
}

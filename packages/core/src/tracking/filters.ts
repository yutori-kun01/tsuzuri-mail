/**
 * 機械的な開封・クリックの判定。どれも経験則で完全ではない。
 * しきい値とパターンは実データを見ながら調整する前提。
 */

export interface ClickSignal {
  method: string;
  userAgent: string | undefined;
  deliveredAt: Date;
  clickedAt: Date;
  /** 同じメールに含まれるリンク数 */
  linksInMessage: number;
  /** 同じメールで、このクリックの前後 burstWindowMs 以内に踏まれた別リンクの数（自分を含む） */
  distinctLinksClickedInBurst: number;
}

export interface FilterSettings {
  /** 配信からこの秒数以内のクリックは自動スキャンとみなす */
  minSecondsAfterDelivery: number;
  /** 同時クリックとみなす時間幅 */
  burstWindowMs: number;
  /** スキャナーとみなすユーザーエージェントの部分一致（小文字で比較） */
  scannerUserAgentPatterns: readonly string[];
}

export const defaultFilterSettings: FilterSettings = {
  minSecondsAfterDelivery: 10,
  burstWindowMs: 2_000,
  scannerUserAgentPatterns: ["bot", "crawler", "spider", "scanner", "preview", "proofpoint", "mimecast", "barracuda"],
};

export type BotReason = "head-request" | "too-fast" | "all-links-burst" | "scanner-user-agent" | "no-user-agent";

/** ボットらしいクリックなら理由を返し、人間らしければ undefined を返す。 */
export function botClickReason(c: ClickSignal, s: FilterSettings = defaultFilterSettings): BotReason | undefined {
  if (c.method.toUpperCase() === "HEAD") return "head-request";
  const ua = c.userAgent?.trim().toLowerCase();
  if (!ua) return "no-user-agent";
  if (s.scannerUserAgentPatterns.some((p) => ua.includes(p))) return "scanner-user-agent";
  if ((c.clickedAt.getTime() - c.deliveredAt.getTime()) / 1000 < s.minSecondsAfterDelivery) return "too-fast";
  if (c.linksInMessage >= 2 && c.distinctLinksClickedInBurst >= c.linksInMessage) return "all-links-burst";
  return undefined;
}

export interface OpenSignal {
  userAgent: string | undefined;
  deliveredAt: Date;
  openedAt: Date;
}

/**
 * 機械開封らしいか。Apple のメールプライバシー保護などのプロキシ取得は、
 * 端末情報の乏しいユーザーエージェントで、配信直後にまとめて来ることが多い。
 * TODO: 実データを集めてから判定条件を見直す。
 */
export function isLikelyMachineOpen(o: OpenSignal, s: FilterSettings = defaultFilterSettings): boolean {
  const ua = o.userAgent?.trim() ?? "";
  if (ua === "") return true;
  if (s.scannerUserAgentPatterns.some((p) => ua.toLowerCase().includes(p))) return true;
  const tooFast = (o.openedAt.getTime() - o.deliveredAt.getTime()) / 1000 < s.minSecondsAfterDelivery;
  // 「Mozilla/5.0」だけで括弧内の端末情報が無いものはプロキシ取得として扱う
  const bare = !ua.includes("(");
  return tooFast || bare;
}

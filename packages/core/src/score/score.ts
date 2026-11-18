import { defaultScoreSettings, type ScoreSettings } from "./settings.js";

const DAY_MS = 86_400_000;

export type EngagementType =
  | "goal"
  | "click"
  | "read"
  | "open"
  | "reply"
  | "ignored";

export interface EngagementEvent {
  type: EngagementType;
  occurredAt: Date;
  /** クリックの重複判定に使う送信記録 id */
  messageId?: string;
  /** open のみ：機械開封と判定されたか */
  machine?: boolean;
  /** goal のみ：目標ごとの点数で上書き */
  weight?: number;
}

export type Tier = "evaluating" | "hot" | "normal" | "low" | "dormant";

export interface ScoreInput {
  now: Date;
  subscribedAt: Date;
  /** 計算対象期間の行動（ボットクリックは除外済みであること） */
  events: readonly EngagementEvent[];
  /** 直近の集計窓での受信・クリック・読了したメール数 */
  window: { delivered: number; clicked: number; read: number };
  /** 全読者の平均クリック率・読了率（0〜1） */
  population: { clickRate: number; readRate: number };
  /** 連続して反応しなかった配信数 */
  noResponseStreak: number;
  /** 前回の区分（ヒステリシス用） */
  previousTier?: Tier;
}

export interface ScoreBreakdown {
  activityPoints: number;
  activityTerm: number;
  clickRateTerm: number;
  readRateTerm: number;
}

export interface ScoreResult {
  score: number;
  tier: Tier;
  breakdown: ScoreBreakdown;
}

/** 経過日数による減衰係数 0.5^(d/H) */
export function decay(ageDays: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

function baseWeight(e: EngagementEvent, s: ScoreSettings, repeat: boolean): number {
  switch (e.type) {
    case "goal":
      return e.weight ?? s.weights.goal;
    case "click":
      return repeat ? s.weights.repeatClick : s.weights.click;
    case "read":
      return s.weights.read;
    case "open":
      return e.machine ? s.weights.machineOpen : s.weights.humanOpen;
    case "reply":
      return s.weights.reply;
    case "ignored":
      return s.weights.ignored;
  }
}

/** A = Σ w_i · 0.5^(d_i/H)。同じメールの2回目以降のクリックは repeatClick で数える。 */
export function activityPoints(
  events: readonly EngagementEvent[],
  now: Date,
  s: ScoreSettings = defaultScoreSettings,
): number {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const clickedMessages = new Set<string>();
  let total = 0;
  for (const e of sorted) {
    let repeat = false;
    if (e.type === "click" && e.messageId !== undefined) {
      repeat = clickedMessages.has(e.messageId);
      clickedMessages.add(e.messageId);
    }
    const ageDays = (now.getTime() - e.occurredAt.getTime()) / DAY_MS;
    total += baseWeight(e, s, repeat) * decay(ageDays, s.halfLifeDays);
  }
  return total;
}

/** 平滑化した率 (x + m·p̄) / (n + m) */
export function smoothedRate(hits: number, delivered: number, populationRate: number, m: number): number {
  return (hits + m * populationRate) / (delivered + m);
}

/** 率の項：平均の2倍で満点。平均が0のときは1回でも反応があれば満点。 */
function rateTerm(rate: number, populationRate: number): number {
  if (populationRate <= 0) return rate > 0 ? 1 : 0;
  return Math.min(rate / (2 * populationRate), 1);
}

export function isEvaluating(input: ScoreInput, s: ScoreSettings = defaultScoreSettings): boolean {
  const ageDays = (input.now.getTime() - input.subscribedAt.getTime()) / DAY_MS;
  return ageDays < s.evaluation.days || input.window.delivered < s.evaluation.minDeliveries;
}

const ORDER: readonly Exclude<Tier, "evaluating">[] = ["dormant", "low", "normal", "hot"];

/** 区分の下限（dormant は 0） */
function lowerBound(t: Exclude<Tier, "evaluating">, s: ScoreSettings): number {
  switch (t) {
    case "hot":
      return s.tiers.hot;
    case "normal":
      return s.tiers.normal;
    case "low":
      return s.tiers.low;
    case "dormant":
      return 0;
  }
}

function rawTier(score: number, s: ScoreSettings): Exclude<Tier, "evaluating"> {
  if (score >= s.tiers.hot) return "hot";
  if (score >= s.tiers.normal) return "normal";
  if (score >= s.tiers.low) return "low";
  return "dormant";
}

/**
 * スコアから区分を決める。
 * - 休眠は「low 未満」かつ「連続未反応が閾値以上」のときだけ。満たさなければ low に留める。
 * - 前回区分がある場合、境界を hysteresis 以上超えたときだけ区分を変える。
 */
export function decideTier(
  score: number,
  noResponseStreak: number,
  previous: Tier | undefined,
  s: ScoreSettings = defaultScoreSettings,
): Exclude<Tier, "evaluating"> {
  let next = rawTier(score, s);
  if (next === "dormant" && noResponseStreak < s.dormantNoResponseStreak) next = "low";

  if (previous === undefined || previous === "evaluating" || previous === next) return next;

  const prevIdx = ORDER.indexOf(previous);
  const nextIdx = ORDER.indexOf(next);
  if (nextIdx > prevIdx) {
    // 上がる：上がった先の下限 + h を超えていること
    return score >= lowerBound(next, s) + s.hysteresis ? next : previous;
  }
  // 下がる：今の区分の下限 - h を下回っていること。休眠への移行は連続未反応の条件で判定済み。
  if (next === "dormant") return next;
  return score < lowerBound(previous, s) - s.hysteresis ? next : previous;
}

export function computeScore(input: ScoreInput, s: ScoreSettings = defaultScoreSettings): ScoreResult {
  const points = activityPoints(input.events, input.now, s);
  const activityTerm = 1 - Math.exp(-Math.max(0, points) / s.saturationK);
  const ctr = smoothedRate(input.window.clicked, input.window.delivered, input.population.clickRate, s.smoothingM);
  const rr = smoothedRate(input.window.read, input.window.delivered, input.population.readRate, s.smoothingM);
  const clickRateTerm = rateTerm(ctr, input.population.clickRate);
  const readRateTerm = rateTerm(rr, input.population.readRate);

  const breakdown: ScoreBreakdown = { activityPoints: points, activityTerm, clickRateTerm, readRateTerm };

  if (isEvaluating(input, s)) {
    return { score: s.evaluation.fixedScore, tier: "evaluating", breakdown };
  }

  const raw =
    100 * (s.mix.activity * activityTerm + s.mix.clickRate * clickRateTerm + s.mix.readRate * readRateTerm);
  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
  return { score, tier: decideTier(score, input.noResponseStreak, input.previousTier, s), breakdown };
}

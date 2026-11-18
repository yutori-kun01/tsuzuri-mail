/** 読者スコアの設定。数値はすべて初期値（仮置き）で、管理画面から変更できる前提。 */
export interface ScoreSettings {
  /** 行動ごとの基礎点 */
  weights: {
    goal: number;
    click: number;
    /** 同じメールの2回目以降のクリック */
    repeatClick: number;
    read: number;
    humanOpen: number;
    machineOpen: number;
    reply: number;
    /** 反応なしで配信を受け取った（負の値） */
    ignored: number;
  };
  /** 何日で行動点が半分になるか */
  halfLifeDays: number;
  /** 活動項の飽和の速さ（A = k のとき約 63%） */
  saturationK: number;
  /** 率の平滑化の強さ（平均的な人 m 通分を下駄に履かせる） */
  smoothingM: number;
  /** 合成の配分（合計 1） */
  mix: { activity: number; clickRate: number; readRate: number };
  /** 区分の下限 */
  tiers: { hot: number; normal: number; low: number };
  /** 区分を変えるのに必要な境界からの超過幅 */
  hysteresis: number;
  /** 休眠と判定する連続未反応数 */
  dormantNoResponseStreak: number;
  /** 評価中とする期間・受信数 */
  evaluation: { days: number; minDeliveries: number; fixedScore: number };
}

export const defaultScoreSettings: ScoreSettings = {
  weights: {
    goal: 25,
    click: 10,
    repeatClick: 2,
    read: 8,
    humanOpen: 2,
    machineOpen: 0.5,
    reply: 15,
    ignored: -1,
  },
  halfLifeDays: 30,
  saturationK: 20,
  smoothingM: 5,
  mix: { activity: 0.6, clickRate: 0.25, readRate: 0.15 },
  tiers: { hot: 70, normal: 40, low: 20 },
  hysteresis: 5,
  dormantNoResponseStreak: 10,
  evaluation: { days: 14, minDeliveries: 5, fixedScore: 50 },
};

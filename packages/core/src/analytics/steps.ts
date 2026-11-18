/** シナリオの各通で、直したほうがよさそうなところを見つける（docs/requirements-2026-11-analytics.md の 3.） */

export interface StepRates {
  id: string;
  sent: number;
  clicked: number;
  unsubscribed: number;
}

export type Flag = "low-click" | "unsub-warn" | "unsub-bad" | "big-drop";

/** 目立たせる通（基準は要件定義の 3.） */
export function stepFlags(steps: readonly StepRates[]): Map<string, Flag[]> {
  const out = new Map<string, Flag[]>();
  const rated = steps.filter((s) => s.sent > 0);
  const avgClick = rated.length ? rated.reduce((a, s) => a + s.clicked / s.sent, 0) / rated.length : 0;
  steps.forEach((s, i) => {
    const f: Flag[] = [];
    if (s.sent > 0) {
      const click = s.clicked / s.sent;
      const unsub = s.unsubscribed / s.sent;
      if (rated.length >= 2 && avgClick > 0 && click < avgClick / 2) f.push("low-click");
      if (unsub >= 0.01) f.push("unsub-bad");
      else if (unsub >= 0.005) f.push("unsub-warn");
      const prev = steps[i - 1];
      if (prev && prev.sent >= 20 && s.sent < prev.sent * 0.7) f.push("big-drop");
    }
    out.set(s.id, f);
  });
  return out;
}

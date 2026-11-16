/*
 * The five component states (docs/spec.md, "States"), always shown in
 * words. The overall state is the worst component state, in RANK order.
 */

export type ComponentState = "operational" | "degraded" | "partial" | "major" | "maintenance"

export const STATE_WORDS: Readonly<Record<ComponentState, string>> = {
  operational: "Operational",
  degraded: "Degraded performance",
  partial: "Partial outage",
  major: "Major outage",
  maintenance: "Maintenance",
}

/** Higher is worse. */
export const STATE_RANK: Readonly<Record<ComponentState, number>> = { operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 }

export function worst(states: readonly ComponentState[]): ComponentState {
  return states.reduce<ComponentState>((w, s) => (STATE_RANK[s] > STATE_RANK[w] ? s : w), "operational")
}

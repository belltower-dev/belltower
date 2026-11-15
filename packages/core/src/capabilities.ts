import type { Capabilities } from "./ports.ts"

/*
 * Assigns each check to the regions that can run it (docs/spec.md,
 * "Capabilities"). A check no region can run is an error at deploy, with the
 * options for fixing it, never a check that silently never runs.
 */

export type CheckType = "http" | "heartbeat" | "email" | "tls" | "domain"

export interface CheckRef {
  id: string
  type: CheckType
  /** Regions named in config; all regions when absent. */
  regions?: readonly string[]
}

export interface Region {
  name: string
  capabilities: Capabilities
}

export type Assignment = { ok: true; byRegion: Record<string, string[]> } | { ok: false; errors: string[] }

/** What a check needs from the region that runs it. */
function needs(type: CheckType): keyof Capabilities | null {
  if (type === "tls") return "tlsInspector"
  if (type === "email") return "inbox"
  return null
}

const FIX: Record<keyof Capabilities, string> = {
  tlsInspector:
    "Add a region on a Node adapter (aws or container) for certificate checks, or use the Certificate Transparency fallback (docs/certificates.md).",
  inbox: "Configure an Inbox on one region, or remove the email check.",
  sms: "Configure an SMS notifier.",
}

/**
 * Heartbeat and email checks are judged where `decide()` runs, so they go to
 * one region only: the first that can run them. Every other check runs in
 * every capable region it's assigned to.
 */
export function assignChecks(checks: readonly CheckRef[], regions: readonly Region[]): Assignment {
  const byRegion: Record<string, string[]> = Object.fromEntries(regions.map((r) => [r.name, []]))
  const errors: string[] = []
  const known = new Set(regions.map((r) => r.name))

  for (const check of checks) {
    const unknown = (check.regions ?? []).filter((name) => !known.has(name))
    if (unknown.length) {
      errors.push(`Check "${check.id}" names regions that aren't configured: ${unknown.join(", ")}.`)
      continue
    }
    const named = check.regions ? regions.filter((r) => check.regions?.includes(r.name)) : regions
    const need = needs(check.type)
    const capable = need ? named.filter((r) => r.capabilities[need]) : named
    if (!capable.length) {
      errors.push(`Check "${check.id}" (${check.type}) can't run in any of its regions. ${need ? FIX[need] : "Assign it at least one region."}`)
      continue
    }
    const single = check.type === "heartbeat" || check.type === "email" || check.type === "tls" || check.type === "domain"
    for (const region of single ? capable.slice(0, 1) : capable) byRegion[region.name]?.push(check.id)
  }

  return errors.length ? { ok: false, errors } : { ok: true, byRegion }
}

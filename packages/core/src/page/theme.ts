import type { PageConfig, StateMark } from "../config.ts"
import { contrast, nearestPassing, parseColor, type Rgb } from "./color.ts"

/*
 * A deployment's theme (docs/spec.md, "Branding"): a shadcn/ui registry
 * theme, whose variables the page uses under their own names, plus the six
 * state colors. Everything is checked for contrast in light and dark before
 * anything is written; a failing pair stops the build with both colors, the
 * ratio, and the nearest value that passes.
 */

/** The shadcn/ui registry theme shape this reads: cssVars.light, cssVars.dark and cssVars.theme. */
export interface RegistryTheme {
  name?: string
  cssVars: {
    theme?: Record<string, string>
    light?: Record<string, string>
    dark?: Record<string, string>
  }
}

export type Mode = "light" | "dark"

/** One mode's variables, by name without the leading dashes, with var() references resolved. */
export type ModeVars = Record<string, string>

export interface ResolvedTheme {
  light: ModeVars
  dark: ModeVars
  radius: string
  /** Font families named by the theme. */
  fonts: { sans?: string; mono?: string; serif?: string }
}

export interface ThemeProblem {
  mode: Mode
  /** What the pair is, in words, such as "Secondary text on muted surfaces". */
  pair: string
  foreground: string
  background: string
  ratio: number
  need: number
  /** The nearest foreground that passes, or null when only the background can change. */
  suggestion: string | null
  /** The variable to change. */
  variable: string
}

/** The variables the page uses. */
export const COLOR_VARIABLES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
] as const

/** Belltower's neutral theme: the default, and the source of anything a theme leaves out. */
export const NEUTRAL_THEME: RegistryTheme = {
  name: "belltower-neutral",
  cssVars: {
    theme: { radius: "0.625rem" },
    light: {
      background: "oklch(1 0 0)",
      foreground: "oklch(0.145 0 0)",
      card: "oklch(1 0 0)",
      "card-foreground": "oklch(0.145 0 0)",
      popover: "oklch(1 0 0)",
      "popover-foreground": "oklch(0.145 0 0)",
      primary: "oklch(0.205 0 0)",
      "primary-foreground": "oklch(0.985 0 0)",
      secondary: "oklch(0.97 0 0)",
      "secondary-foreground": "oklch(0.205 0 0)",
      muted: "oklch(0.97 0 0)",
      "muted-foreground": "oklch(0.48 0 0)",
      accent: "oklch(0.97 0 0)",
      "accent-foreground": "oklch(0.205 0 0)",
      destructive: "oklch(0.55 0.22 27.325)",
      border: "oklch(0.922 0 0)",
      input: "oklch(0.922 0 0)",
      ring: "oklch(0.708 0 0)",
    },
    dark: {
      background: "oklch(0.145 0 0)",
      foreground: "oklch(0.985 0 0)",
      card: "oklch(0.205 0 0)",
      "card-foreground": "oklch(0.985 0 0)",
      popover: "oklch(0.205 0 0)",
      "popover-foreground": "oklch(0.985 0 0)",
      primary: "oklch(0.922 0 0)",
      "primary-foreground": "oklch(0.205 0 0)",
      secondary: "oklch(0.269 0 0)",
      "secondary-foreground": "oklch(0.985 0 0)",
      muted: "oklch(0.269 0 0)",
      "muted-foreground": "oklch(0.72 0 0)",
      accent: "oklch(0.269 0 0)",
      "accent-foreground": "oklch(0.985 0 0)",
      destructive: "oklch(0.704 0.191 22.216)",
      border: "oklch(1 0 0 / 10%)",
      input: "oklch(1 0 0 / 15%)",
      ring: "oklch(0.556 0 0)",
    },
  },
}

/** Belltower's state colors, for any mark the deployment doesn't color itself. Major outage defaults to the theme's destructive. */
const STATE_DEFAULTS: Record<Exclude<StateMark, "major">, { light: string; dark: string }> = {
  operational: { light: "oklch(0.52 0.12 155)", dark: "oklch(0.75 0.13 155)" },
  degraded: { light: "oklch(0.55 0.12 75)", dark: "oklch(0.8 0.13 80)" },
  partial: { light: "oklch(0.55 0.15 45)", dark: "oklch(0.74 0.14 50)" },
  maintenance: { light: "oklch(0.52 0.09 250)", dark: "oklch(0.74 0.09 250)" },
  nodata: { light: "oklch(0.55 0 0)", dark: "oklch(0.6 0 0)" },
}

export const STATE_MARK_LIST: readonly StateMark[] = ["operational", "degraded", "partial", "major", "maintenance", "nodata"]

/** Reads a theme, or explains what's wrong with it. */
export function readRegistryTheme(value: unknown): RegistryTheme | string {
  if (typeof value !== "object" || value === null) return "isn't an object."
  const cssVars = (value as { cssVars?: unknown }).cssVars
  if (typeof cssVars !== "object" || cssVars === null) return "has no cssVars. Use a theme in the shadcn/ui registry format."
  const v = cssVars as Record<string, unknown>
  if (typeof v.light !== "object" || typeof v.dark !== "object") return "needs both cssVars.light and cssVars.dark."
  return value as RegistryTheme
}

const BARE_HSL = /^-?[\d.]+\s+[\d.]+%\s+[\d.]+%$/

/** Replaces var(--name) with that variable's value, and wraps older themes' bare HSL in hsl(). */
function resolveValue(value: string, vars: Record<string, string>, depth = 0): string {
  const v = value.trim()
  if (BARE_HSL.test(v)) return `hsl(${v})`
  if (depth > 8) return v
  return v.replace(/var\(--([a-z0-9-]+)\s*(?:,\s*([^)]+))?\)/gi, (_, name: string, fallback?: string) => {
    const found = vars[name] ?? fallback
    return found === undefined ? `var(--${name})` : resolveValue(found, vars, depth + 1)
  })
}

/**
 * The page's variables for each mode: the theme's, then the neutral
 * theme's for anything it leaves out, then the state colors as
 * state-operational and so on.
 */
export function resolveTheme(theme: RegistryTheme = NEUTRAL_THEME, states: PageConfig["states"] = {}): ResolvedTheme {
  const shared = theme.cssVars.theme ?? {}
  const radius = theme.cssVars.light?.radius ?? shared.radius ?? NEUTRAL_THEME.cssVars.theme?.radius ?? "0.625rem"
  const forMode = (mode: Mode): ModeVars => {
    const raw: Record<string, string> = { ...NEUTRAL_THEME.cssVars[mode], ...shared, ...theme.cssVars[mode] }
    const out: ModeVars = {}
    for (const name of COLOR_VARIABLES) out[name] = resolveValue(raw[name] ?? "", raw)
    for (const mark of STATE_MARK_LIST) {
      const own = states[mark]?.[mode]
      out[`state-${mark}`] = own ?? (mark === "major" ? (out.destructive ?? "") : STATE_DEFAULTS[mark as Exclude<StateMark, "major">][mode])
    }
    return out
  }
  const fonts: ResolvedTheme["fonts"] = {}
  const font = (key: string) => shared[key] ?? theme.cssVars.light?.[key]
  const sans = font("font-sans")
  const mono = font("font-mono")
  const serif = font("font-serif")
  if (sans) fonts.sans = sans
  if (mono) fonts.mono = mono
  if (serif) fonts.serif = serif
  return { light: forMode("light"), dark: forMode("dark"), radius, fonts }
}

/**
 * Checks every pair the page draws, in both modes: text and secondary text
 * 4.5:1 on the background, cards and muted surfaces; state marks 3:1 on
 * the background and cards; the primary button's text 4.5:1 on its fill.
 * Control borders and the focus outline use the text colors, so they pass
 * when the text does. Returns every failure; an empty list passes.
 */
export function checkContrast(theme: ResolvedTheme): ThemeProblem[] {
  const problems: ThemeProblem[] = []
  for (const mode of ["light", "dark"] as const) {
    const vars = theme[mode]
    const unreadable = new Set<string>()
    const get = (name: string): Rgb | null => {
      const c = parseColor(vars[name] ?? "")
      if (!c && !unreadable.has(name)) {
        unreadable.add(name)
        problems.push({ mode, pair: `The color ${name}`, foreground: vars[name] ?? "", background: "", ratio: 0, need: 0, suggestion: null, variable: name })
      }
      return c
    }
    const pair = (fgName: string, bgName: string, label: string, where: string, need: number) => {
      const fg = get(fgName)
      const bgRaw = get(bgName)
      if (!fg || !bgRaw) return
      // A translucent surface sits on the page background.
      const page = get("background")
      const bg = bgRaw.a < 1 && page ? { ...bgRaw, ...blend(bgRaw, page) } : bgRaw
      const ratio = contrast(fg, bg)
      if (ratio + 1e-9 >= need) return
      problems.push({
        mode,
        pair: `${label} on ${where}`,
        foreground: vars[fgName] ?? "",
        background: vars[bgName] ?? "",
        ratio: Math.floor(ratio * 100) / 100,
        need,
        suggestion: nearestPassing(fg, bg, need),
        variable: fgName,
      })
    }
    const surfaces: [string, string][] = [
      ["background", "the page background"],
      ["card", "cards"],
      ["muted", "muted surfaces"],
    ]
    for (const [bg, where] of surfaces) {
      pair("foreground", bg, "Text", where, 4.5)
      pair("muted-foreground", bg, "Secondary text", where, 4.5)
    }
    for (const mark of STATE_MARK_LIST) {
      for (const [bg, where] of surfaces.slice(0, 2)) pair(`state-${mark}`, bg, `The ${mark} mark`, where, 3)
    }
    pair("primary-foreground", "primary", "Button text", "the primary color", 4.5)
    pair("primary", "background", "The primary button", "the page background", 3)
  }
  return problems
}

function blend(fg: Rgb, bg: Rgb): Rgb {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 }
}

/** Where each variable is set, for messages people can act on. */
function source(variable: string): string {
  if (variable.startsWith("state-")) {
    const mark = variable.slice(6)
    return mark === "major" ? "page.states.major (or the theme's destructive)" : `page.states.${mark}`
  }
  return `the theme's ${variable}`
}

/** One line per problem, naming the colors, the ratio, and what to change. */
export function describeProblem(p: ThemeProblem): string {
  if (!p.need) return `${p.mode} mode: ${source(p.variable)} is ${p.foreground ? `"${p.foreground}"` : "missing"}, which isn't a color the build can read. Use hex, rgb(), hsl(), oklch() or color-mix().`
  const fix = p.suggestion ? ` Change ${source(p.variable)} to ${p.suggestion}, or a color with more contrast.` : ` No lightness of ${source(p.variable)} passes on this background; change the background instead.`
  return `${p.mode} mode: ${p.pair} is ${p.ratio}:1 (${p.foreground} on ${p.background}); it needs ${p.need}:1.${fix}`
}

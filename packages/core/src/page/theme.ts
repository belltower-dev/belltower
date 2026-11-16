import type { PageConfig, StateMark } from "../config.ts"
import { contrast, nearestPassing, parseColor, type Rgb } from "./color.ts"

/*
 * A deployment's theme (docs/spec.md, "Branding"): a shadcn/ui registry
 * theme, mapped onto the page's variables and checked for contrast in light
 * and dark before anything is written. A failing pair stops the build with
 * both colors, the ratio, and the nearest value that passes.
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

/** The page's variables for one mode, by name without the leading dashes. */
export type ModeVars = Record<string, string>

export interface ResolvedTheme {
  light: ModeVars
  dark: ModeVars
  /** Font families named by the theme, for the font stacks. */
  fonts: { sans?: string; mono?: string; serif?: string }
}

export interface ThemeProblem {
  mode: Mode
  /** What the pair is, in words, such as "Text on muted surfaces". */
  pair: string
  foreground: string
  background: string
  ratio: number
  need: number
  /** The nearest foreground that passes, or null when only the background can change. */
  suggestion: string | null
  /** The theme variable to change. */
  variable: string
}

/** Belltower's neutral theme: the default when a deployment sets none. */
export const NEUTRAL_THEME: RegistryTheme = {
  name: "belltower-neutral",
  cssVars: {
    theme: { radius: "0.625rem" },
    light: {
      background: "oklch(1 0 0)",
      foreground: "oklch(0.145 0 0)",
      card: "oklch(1 0 0)",
      "card-foreground": "oklch(0.145 0 0)",
      primary: "oklch(0.205 0 0)",
      "primary-foreground": "oklch(0.985 0 0)",
      secondary: "oklch(0.97 0 0)",
      "secondary-foreground": "oklch(0.205 0 0)",
      muted: "oklch(0.97 0 0)",
      "muted-foreground": "oklch(0.45 0 0)",
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
      primary: "oklch(0.922 0 0)",
      "primary-foreground": "oklch(0.205 0 0)",
      secondary: "oklch(0.269 0 0)",
      "secondary-foreground": "oklch(0.985 0 0)",
      muted: "oklch(0.205 0 0)",
      "muted-foreground": "oklch(0.708 0 0)",
      accent: "oklch(0.269 0 0)",
      "accent-foreground": "oklch(0.985 0 0)",
      destructive: "oklch(0.704 0.191 22.216)",
      border: "oklch(0.269 0 0)",
      input: "oklch(0.32 0 0)",
      ring: "oklch(0.556 0 0)",
    },
  },
}

/** Belltower's state colors, used for any mark the deployment doesn't color itself. Major outage defaults to the theme's destructive. */
const STATE_DEFAULTS: Record<Exclude<StateMark, "major">, { light: string; dark: string }> = {
  operational: { light: "oklch(0.52 0.12 155)", dark: "oklch(0.75 0.13 155)" },
  degraded: { light: "oklch(0.55 0.12 75)", dark: "oklch(0.8 0.13 80)" },
  partial: { light: "oklch(0.55 0.15 45)", dark: "oklch(0.74 0.14 50)" },
  maintenance: { light: "oklch(0.52 0.09 250)", dark: "oklch(0.74 0.09 250)" },
  nodata: { light: "oklch(0.55 0 0)", dark: "oklch(0.6 0 0)" },
}

/** Which page variable each state mark sets. */
export const STATE_VARIABLE: Record<StateMark, string> = {
  operational: "color-success",
  degraded: "color-warning",
  partial: "color-accent",
  major: "color-error",
  maintenance: "color-info",
  nodata: "color-neutral",
}

/** Reads a theme given inline, or explains what's wrong with it. */
export function readRegistryTheme(value: unknown): RegistryTheme | string {
  if (typeof value !== "object" || value === null) return "isn't an object."
  const cssVars = (value as { cssVars?: unknown }).cssVars
  if (typeof cssVars !== "object" || cssVars === null) return "has no cssVars. Use a theme in the shadcn/ui registry format."
  const v = cssVars as Record<string, unknown>
  if (typeof v.light !== "object" || typeof v.dark !== "object") return "needs both cssVars.light and cssVars.dark."
  return value as RegistryTheme
}

/**
 * Maps a theme and the deployment's state colors onto the page's
 * variables. Missing values come from the neutral theme, so a partial
 * theme still builds.
 */
export function resolveTheme(theme: RegistryTheme = NEUTRAL_THEME, states: PageConfig["states"] = {}): ResolvedTheme {
  const shared = { ...NEUTRAL_THEME.cssVars.theme, ...theme.cssVars.theme }
  const pick = (mode: Mode, key: string): string =>
    theme.cssVars[mode]?.[key] ?? shared[key] ?? NEUTRAL_THEME.cssVars[mode]?.[key] ?? NEUTRAL_THEME.cssVars.theme?.[key] ?? ""
  const color = (value: string) => (/^-?[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(value.trim()) ? `hsl(${value})` : value)
  const radius = theme.cssVars.light?.radius ?? shared.radius ?? "0.625rem"

  const forMode = (mode: Mode): ModeVars => {
    const vars: ModeVars = {
      "color-base-100": color(pick(mode, "background")),
      "color-base-200": color(pick(mode, "muted")),
      "color-base-300": color(pick(mode, "border")),
      "color-base-content": color(pick(mode, "foreground")),
      "color-primary": color(pick(mode, "primary")),
      "color-primary-content": color(pick(mode, "primary-foreground")),
      "color-secondary": color(pick(mode, "secondary")),
      "color-secondary-content": color(pick(mode, "secondary-foreground")),
      "color-neutral-content": color(pick(mode, "background")),
      "color-error": color(pick(mode, "destructive")),
      "radius-box": radius,
      "radius-field": `calc(${radius} - 2px)`,
      "radius-selector": "1rem",
    }
    for (const [mark, fallback] of Object.entries(STATE_DEFAULTS) as [Exclude<StateMark, "major">, { light: string; dark: string }][]) {
      vars[STATE_VARIABLE[mark]] = states[mark]?.[mode] ?? fallback[mode]
    }
    if (states.major) vars["color-error"] = states.major[mode]
    // Text on the state colors (rarely used, but kept readable): the page background.
    for (const name of ["success", "warning", "accent", "error", "info"]) vars[`color-${name}-content`] = vars["color-base-100"] ?? ""
    return vars
  }
  const fonts: ResolvedTheme["fonts"] = {}
  const font = (key: string) => theme.cssVars.theme?.[key] ?? theme.cssVars.light?.[key]
  const sans = font("font-sans")
  const mono = font("font-mono")
  const serif = font("font-serif")
  if (sans) fonts.sans = sans
  if (mono) fonts.mono = mono
  if (serif) fonts.serif = serif
  return { light: forMode("light"), dark: forMode("dark"), fonts }
}

/** Secondary text on the page is the foreground at this opacity. */
export const SECONDARY_TEXT_OPACITY = 0.7

/**
 * Checks every pair the page draws, in both modes: text and state words
 * 4.5:1 on each surface, state marks and icons 3:1, and the primary
 * button's text on its fill. Returns every failure; an empty list passes.
 */
export function checkContrast(theme: ResolvedTheme): ThemeProblem[] {
  const problems: ThemeProblem[] = []
  for (const mode of ["light", "dark"] as const) {
    const vars = theme[mode]
    const get = (name: string): Rgb | null => parseColor(vars[name] ?? "")
    const unreadable = (name: string) =>
      problems.push({ mode, pair: `The color ${name}`, foreground: vars[name] ?? "", background: "", ratio: 0, need: 0, suggestion: null, variable: name })
    const surfaces: [string, string][] = [
      ["color-base-100", "the page background"],
      ["color-base-200", "muted surfaces"],
    ]
    const check = (fgName: string, label: string, need: number, opacity = 1) => {
      const fgRaw = get(fgName)
      if (!fgRaw) return unreadable(fgName)
      for (const [bgName, where] of surfaces) {
        const bg = get(bgName)
        if (!bg) return unreadable(bgName)
        const fg = { ...fgRaw, a: fgRaw.a * opacity }
        const ratio = contrast(fg, bg)
        if (ratio + 1e-9 < need) {
          problems.push({
            mode,
            pair: `${label} on ${where}`,
            foreground: opacity < 1 ? `${vars[fgName]} at ${Math.round(opacity * 100)}%` : (vars[fgName] ?? ""),
            background: vars[bgName] ?? "",
            ratio: Math.floor(ratio * 100) / 100,
            need,
            suggestion: nearestPassing(fgRaw, bg, need, opacity),
            variable: fgName,
          })
        }
      }
    }
    check("color-base-content", "Text", 4.5)
    check("color-base-content", "Secondary text", 4.5, SECONDARY_TEXT_OPACITY)
    for (const [mark, variable] of Object.entries(STATE_VARIABLE)) check(variable, `The ${mark} mark`, 3)

    const primary = get("color-primary")
    const onPrimary = get("color-primary-content")
    if (!primary) unreadable("color-primary")
    else if (!onPrimary) unreadable("color-primary-content")
    else {
      const ratio = contrast(onPrimary, primary)
      if (ratio < 4.5) {
        problems.push({
          mode,
          pair: "Button text on the primary color",
          foreground: vars["color-primary-content"] ?? "",
          background: vars["color-primary"] ?? "",
          ratio: Math.floor(ratio * 100) / 100,
          need: 4.5,
          suggestion: nearestPassing(onPrimary, primary, 4.5),
          variable: "color-primary-content",
        })
      }
      // The primary button must also stand out from the page: 3:1 for its fill.
      const bg = get("color-base-100")
      if (bg && contrast(primary, bg) < 3) {
        problems.push({
          mode,
          pair: "The primary color on the page background",
          foreground: vars["color-primary"] ?? "",
          background: vars["color-base-100"] ?? "",
          ratio: Math.floor(contrast(primary, bg) * 100) / 100,
          need: 3,
          suggestion: nearestPassing(primary, bg, 3),
          variable: "color-primary",
        })
      }
    }
  }
  return problems
}

/** Which shadcn/ui variable a page variable comes from, for messages people can act on. */
const SOURCE: Record<string, string> = {
  "color-base-100": "background",
  "color-base-200": "muted",
  "color-base-content": "foreground",
  "color-primary": "primary",
  "color-primary-content": "primary-foreground",
  "color-error": "destructive, or page.states.major",
  "color-success": "page.states.operational",
  "color-warning": "page.states.degraded",
  "color-accent": "page.states.partial",
  "color-info": "page.states.maintenance",
  "color-neutral": "page.states.nodata",
}

/** One line per problem, naming the colors, the ratio, and what to change. */
export function describeProblem(p: ThemeProblem): string {
  if (!p.need) return `${p.mode} mode: ${p.pair} (${p.foreground || "missing"}) isn't a color the build can read. Use hex, rgb(), hsl() or oklch().`
  const fix = p.suggestion ? ` Change ${SOURCE[p.variable] ?? p.variable} to ${p.suggestion} or one with more contrast.` : ` No ${SOURCE[p.variable] ?? p.variable} passes on this background; change the background instead.`
  return `${p.mode} mode: ${p.pair} is ${p.ratio}:1 (${p.foreground} on ${p.background}); it needs ${p.need}:1.${fix}`
}

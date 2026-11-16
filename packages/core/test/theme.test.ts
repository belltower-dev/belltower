import { describe, expect, it } from "vitest"
import { contrast, nearestPassing, parseColor } from "../src/page/color.ts"
import { NEUTRAL_THEME, checkContrast, describeProblem, readRegistryTheme, resolveTheme, type RegistryTheme } from "../src/page/theme.ts"

const rgb = (s: string) => {
  const c = parseColor(s)
  if (!c) throw new Error(`can't read ${s}`)
  return c
}

describe("parseColor", () => {
  it("reads hex, rgb, hsl, bare HSL triplets and oklch to the same white and black", () => {
    for (const white of ["#fff", "#ffffff", "rgb(255 255 255)", "rgb(255, 255, 255)", "hsl(0 0% 100%)", "0 0% 100%", "oklch(1 0 0)", "oklch(100% 0 0)"]) {
      const c = rgb(white)
      expect([c.r, c.g, c.b].map((x) => Math.round(x * 255))).toEqual([255, 255, 255])
    }
    expect(Math.round(rgb("oklch(0.628 0.2577 29.23)").r * 255)).toBe(255) // sRGB red
    expect(rgb("#00000080").a).toBeCloseTo(0.5, 2)
    expect(rgb("oklch(1 0 0 / 10%)").a).toBeCloseTo(0.1)
    expect(parseColor("color-mix(in oklab, red, blue)")).toBeNull()
  })

  it("gives WCAG contrast ratios", () => {
    expect(contrast(rgb("#000"), rgb("#fff"))).toBeCloseTo(21, 1)
    expect(contrast(rgb("#767676"), rgb("#fff"))).toBeCloseTo(4.54, 1)
  })

  it("finds the nearest lightness that passes", () => {
    const suggestion = nearestPassing(rgb("#999"), rgb("#fff"), 4.5)
    expect(suggestion).toMatch(/^oklch\(/)
    expect(contrast(rgb(suggestion ?? ""), rgb("#fff"))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rgb(nearestPassing(rgb("#999"), rgb("#fff"), 4.5, 0.7) ?? ""), rgb("#fff"))).toBeGreaterThan(4.5)
  })
})

describe("the theme", () => {
  it("maps a shadcn/ui theme onto the page and passes with the neutral theme", () => {
    const resolved = resolveTheme()
    expect(resolved.light.background).toBe("oklch(1 0 0)")
    expect(resolved.dark.foreground).toBe("oklch(0.985 0 0)")
    expect(resolved.light["state-major"]).toBe(resolved.light.destructive)
    expect(resolved.radius).toBe("0.625rem")
    expect(checkContrast(resolved)).toEqual([])
  })

  it("wraps bare HSL values, keeps fonts, and takes the deployment's state colors", () => {
    const theme: RegistryTheme = {
      cssVars: {
        theme: { "font-sans": "Plus Jakarta Sans, sans-serif", radius: "1rem" },
        light: { background: "0 0% 100%", foreground: "222.2 84% 4.9%" },
        dark: { background: "222.2 84% 4.9%", foreground: "210 40% 98%" },
      },
    }
    const resolved = resolveTheme(theme, { operational: { light: "#15803d", dark: "#4ade80" } })
    expect(resolved.light.background).toBe("hsl(0 0% 100%)")
    expect(resolved.light["state-operational"]).toBe("#15803d")
    expect(resolved.fonts).toEqual({ sans: "Plus Jakarta Sans, sans-serif" })
    expect(resolved.radius).toBe("1rem")
  })

  it("refuses low contrast with both colors, the ratio and a value that passes", () => {
    const theme: RegistryTheme = { ...NEUTRAL_THEME, cssVars: { ...NEUTRAL_THEME.cssVars, light: { ...NEUTRAL_THEME.cssVars.light, foreground: "#9ca3af" } } }
    const problems = checkContrast(resolveTheme(theme, { degraded: { light: "#fde68a", dark: "#fde68a" } }))
    const lines = problems.map(describeProblem)
    expect(lines[0]).toMatch(/^light mode: Text on the page background is 2\.\d+:1 \(#9ca3af on oklch\(1 0 0\)\); it needs 4\.5:1\. Change the theme's foreground to oklch\(/)
    expect(lines.some((l) => l.startsWith("light mode: The degraded mark on the page background"))).toBe(true)
    expect(lines.some((l) => l.includes("page.states.degraded"))).toBe(true)
    // Each suggestion passes where it would be used.
    for (const p of problems.filter((p) => p.pair === "Text on the page background")) {
      expect(contrast(rgb(p.suggestion ?? ""), rgb(p.background))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("resolves var() and color-mix(), as themes write muted text", () => {
    const theme: RegistryTheme = {
      cssVars: {
        light: { foreground: "oklch(0.19 0 0)", "muted-foreground": "color-mix(in oklab, var(--foreground) 75%, transparent)" },
        dark: {},
      },
    }
    const resolved = resolveTheme(theme)
    expect(resolved.light["muted-foreground"]).toBe("color-mix(in oklab, oklch(0.19 0 0) 75%, transparent)")
    expect(parseColor(resolved.light["muted-foreground"] ?? "")?.a).toBeCloseTo(0.75)
    expect(checkContrast(resolved).filter((p) => p.mode === "light")).toEqual([])
  })

  it("says which colors it can't read", () => {
    const theme: RegistryTheme = { cssVars: { light: { background: "var(--white)" }, dark: {} } }
    expect(checkContrast(resolveTheme(theme)).map(describeProblem)[0]).toContain("isn't a color the build can read")
    expect(readRegistryTheme({ name: "x" })).toBe("has no cssVars. Use a theme in the shadcn/ui registry format.")
  })
})

/*
 * Color parsing and WCAG contrast for the build-time theme check
 * (docs/spec.md, "Branding"). Reads the color forms shadcn/ui themes use:
 * hex, rgb(), hsl(), bare HSL triplets ("222.2 84% 4.9%") and oklch().
 */

/** sRGB channels from 0 to 1, and alpha. */
export interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))

function num(part: string, percentScale: number): number {
  const p = part.trim()
  if (p.endsWith("%")) return (Number(p.slice(0, -1)) / 100) * percentScale
  return Number(p)
}

function angle(part: string): number {
  const p = part.trim()
  if (p.endsWith("deg")) return Number(p.slice(0, -3))
  if (p.endsWith("turn")) return Number(p.slice(0, -4)) * 360
  if (p.endsWith("rad")) return (Number(p.slice(0, -3)) * 180) / Math.PI
  return Number(p)
}

/** Splits "a b c / d" or "a, b, c, d" into channels and alpha. */
function channels(inner: string): { parts: string[]; alpha: number } {
  const [main = "", alpha] = inner.includes("/") ? inner.split("/") : [inner]
  const parts = main.split(/[\s,]+/).filter(Boolean)
  const a = alpha !== undefined ? num(alpha, 1) : parts.length === 4 ? num(parts.pop() ?? "1", 1) : 1
  return { parts, alpha: a }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0), f(8), f(4)]
}

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const L = l_ ** 3
  const M = m_ ** 3
  const S = s_ ** 3
  const lin = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S]
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return [gamma(lin[0] ?? 0), gamma(lin[1] ?? 0), gamma(lin[2] ?? 0)]
}

/** Parses a CSS color, or returns null for a form it doesn't read. */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    let h = hex[1] ?? ""
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("")
    if (h.length !== 6 && h.length !== 8) return null
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 }
  }
  const fn = /^([a-z]+)\((.*)\)$/.exec(s)
  if (fn) {
    const { parts, alpha } = channels(fn[2] ?? "")
    if (parts.length !== 3) return null
    const [p0 = "", p1 = "", p2 = ""] = parts
    let rgb: [number, number, number] | null = null
    if (fn[1] === "rgb" || fn[1] === "rgba") rgb = [num(p0, 255) / 255, num(p1, 255) / 255, num(p2, 255) / 255]
    else if (fn[1] === "hsl" || fn[1] === "hsla") rgb = hslToRgb(angle(p0), num(p1, 1) / (p1.endsWith("%") ? 1 : 100), num(p2, 1) / (p2.endsWith("%") ? 1 : 100))
    else if (fn[1] === "oklch") rgb = oklchToRgb(num(p0, 1), num(p1, 0.4), angle(p2))
    if (!rgb || rgb.some((x) => Number.isNaN(x)) || Number.isNaN(alpha)) return null
    return { r: clamp(rgb[0]), g: clamp(rgb[1]), b: clamp(rgb[2]), a: clamp(alpha) }
  }
  // shadcn/ui's older themes write HSL without the function: "222.2 84% 4.9%".
  const bare = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(s)
  if (bare) {
    const rgb = hslToRgb(Number(bare[1]), Number(bare[2]) / 100, Number(bare[3]) / 100)
    return { r: clamp(rgb[0]), g: clamp(rgb[1]), b: clamp(rgb[2]), a: 1 }
  }
  return null
}

/** A color drawn over a background, for translucent colors and text at reduced opacity. */
export function over(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }
}

function luminance(c: Rgb): number {
  const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG 2.1 contrast ratio, from 1 to 21. The foreground is drawn over the background first. */
export function contrast(fg: Rgb, bg: Rgb): number {
  const f = luminance(over(fg, bg))
  const b = luminance(bg)
  return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05)
}

function toOklch(c: Rgb): { l: number; c: number; h: number } {
  const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  const r = lin(c.r)
  const g = lin(c.g)
  const b = lin(c.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.sqrt(A * A + B * B), h: h < 0 ? h + 360 : h }
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

export function formatOklch(l: number, c: number, h: number): string {
  return `oklch(${round(l * 100, 1)}% ${round(c, 3)} ${round(h, 1)})`
}

/**
 * The nearest color to `fg`, changing only its lightness, that reaches
 * `need` against `bg` when drawn at `opacity`; null when no lightness does.
 */
export function nearestPassing(fg: Rgb, bg: Rgb, need: number, opacity = 1): string | null {
  const { l, c, h } = toOklch(fg)
  const ratioAt = (lightness: number) => {
    const [r, g, b] = oklchToRgb(lightness, c, h)
    return contrast({ r: clamp(r), g: clamp(g), b: clamp(b), a: fg.a * opacity }, bg)
  }
  let best: number | null = null
  for (const direction of [-1, 1]) {
    const end = direction < 0 ? 0 : 1
    if (ratioAt(end) < need) continue
    // Binary search between the current lightness and the end that passes.
    let lo = l
    let hi = end
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (ratioAt(mid) >= need) hi = mid
      else lo = mid
    }
    if (best === null || Math.abs(hi - l) < Math.abs(best - l)) best = hi
  }
  if (best === null) return null
  // Step a little past the boundary so rounding never lands just below it.
  const target = best + (best < l ? -0.005 : 0.005)
  return formatOklch(clamp(target), c, h)
}

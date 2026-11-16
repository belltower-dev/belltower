import { slug } from "../feeds.ts"
import type { Store } from "../ports.ts"

/*
 * Fonts a theme names (docs/spec.md, "Branding"): fetched once when the
 * page is built and served from the page's own host, so visitors make no
 * third-party requests. Google Fonts is the source, since shadcn/ui and
 * tweakcn themes name fonts from it and its fonts may be redistributed.
 */

/** A font's @font-face rules, with its files' addresses rewritten to the page's own fonts/ folder. */
export interface FontFiles {
  css: string
  /** Path under the page's root to bytes. Empty when the files are already published. */
  files: Record<string, Uint8Array>
}

/** Loads a family, or returns null when the source doesn't have it. */
export type FontLoader = (family: string) => Promise<FontFiles | null>

/** Names that are generic or installed with every system, so there's nothing to fetch. */
const SYSTEM = new Set(
  [
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
    "-apple-system", "blinkmacsystemfont", "segoe ui", "helvetica", "helvetica neue", "arial", "georgia", "times", "times new roman",
    "courier", "courier new", "menlo", "monaco", "consolas", "sfmono-regular", "apple color emoji", "segoe ui emoji", "noto color emoji",
  ],
)

/** The family a font stack starts with, unless it's one every system has. */
export function firstFamily(stack: string | undefined): string | null {
  const first = stack?.split(",")[0]?.trim().replace(/^["']|["']$/g, "")
  return first && !SYSTEM.has(first.toLowerCase()) ? first : null
}

/** The weights the page uses: regular text, medium labels, semibold headings, bold. */
const WEIGHTS = ["400;500;600;700", "400;700", ""]

/** Google Fonts serves WOFF2 only to browsers that read it, so the request says it's one. */
const WOFF2_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

export function googleFonts(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): FontLoader {
  return async (family) => {
    let css: string | null = null
    for (const weights of WEIGHTS) {
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}${weights ? `:wght@${weights}` : ""}&display=swap`
      const response = await fetchImpl(url, { headers: { "User-Agent": WOFF2_AGENT } })
      if (response.ok) {
        css = await response.text()
        break
      }
      await response.body?.cancel()
      // 400 means the family or one of the weights doesn't exist: try fewer weights, then none.
      if (response.status !== 400) throw new Error(`Google Fonts answered ${response.status}`)
    }
    if (css === null) return null
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+?\.woff2)\)/g)].map((m) => m[1] ?? ""))]
    if (!urls.length) return null
    const files: Record<string, Uint8Array> = {}
    let rewritten = css.replace(/\/\*[^*]*\*\//g, "").trim()
    for (const [i, url] of urls.entries()) {
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`a font file answered ${response.status}`)
      const path = `fonts/${slug(family)}-${i + 1}.woff2`
      files[path] = new Uint8Array(await response.arrayBuffer())
      rewritten = rewritten.split(url).join(path)
    }
    return { css: rewritten, files }
  }
}

/** The path of a family's published @font-face rules, which also mark it as fetched. */
export function fontCssPath(family: string): string {
  return `fonts/${slug(family)}.css`
}

/**
 * Reuses fonts already published beside the page, so rebuilding every few
 * minutes doesn't fetch them again. For builds that write to the store.
 */
export function cachedFonts(store: Store, loader: FontLoader): FontLoader {
  return async (family) => {
    const css = await store.get(`public/${fontCssPath(family)}`)
    if (css !== null) return { css, files: {} }
    return loader(family)
  }
}

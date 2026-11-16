import { describe, expect, it } from "vitest"
import { buildNotes, buildPage, cachedFonts, firstFamily, googleFonts, memoryStore, publicPage, publicStatus, validateConfig, writePage } from "../src/index.ts"

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }
const now = new Date("2026-11-15T14:20:00Z")

/** A stand-in for Google Fonts: Inter has 400 to 700; Lobster only 400; nothing else exists. */
function fakeGoogle() {
  const asked: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    asked.push(url)
    if (url.startsWith("https://fonts.gstatic.com/")) return new Response(new TextEncoder().encode(`bytes of ${url.split("/").pop()}`))
    const family = new URL(url).searchParams.get("family") ?? ""
    const face = (name: string, file: string, weight: number) =>
      `/* latin */\n@font-face {\n  font-family: '${name}';\n  font-weight: ${weight};\n  src: url(https://fonts.gstatic.com/s/${file}) format('woff2');\n}`
    if (family === "Inter:wght@400;500;600;700") return new Response([400, 500, 600, 700].map((w) => face("Inter", "inter-var.woff2", w)).join("\n"))
    if (family === "Lobster") return new Response(face("Lobster", "lobster.woff2", 400))
    return new Response("Bad Request", { status: 400 })
  }) as typeof fetch
  return { fetchImpl, asked }
}

describe("googleFonts", () => {
  it("fetches the CSS and each file once, and points the CSS at the page's own folder", async () => {
    const { fetchImpl, asked } = fakeGoogle()
    const font = await googleFonts(fetchImpl)("Inter")
    expect(Object.keys(font?.files ?? {})).toEqual(["fonts/inter-1.woff2"])
    expect(font?.css).toContain("src: url(fonts/inter-1.woff2) format('woff2');")
    expect(font?.css).not.toContain("gstatic")
    expect(font?.css).not.toContain("/* latin */")
    expect(asked.filter((u) => u.includes("gstatic"))).toHaveLength(1)
  })

  it("tries fewer weights before giving up, and returns null for a family it doesn't have", async () => {
    const { fetchImpl } = fakeGoogle()
    expect(Object.keys((await googleFonts(fetchImpl)("Lobster"))?.files ?? {})).toEqual(["fonts/lobster-1.woff2"])
    expect(await googleFonts(fetchImpl)("Made Up Sans")).toBeNull()
  })

  it("skips system fonts", () => {
    expect(firstFamily('"Plus Jakarta Sans", sans-serif')).toBe("Plus Jakarta Sans")
    expect(firstFamily("ui-sans-serif, system-ui")).toBeNull()
    expect(firstFamily("Helvetica Neue, Arial")).toBeNull()
    expect(firstFamily(undefined)).toBeNull()
  })
})

describe("buildPage with fonts", () => {
  async function world(fontSans: string) {
    const result = validateConfig(
      {
        page: { name: "Example", theme: { cssVars: { theme: { "font-sans": fontSans, "font-mono": "ui-monospace, monospace" }, light: {}, dark: {} } } },
        components: [{ name: "Website" }],
        notifiers: [{ id: "ops", type: "webhook", secret: "HOOK" }],
        checks: [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/" }],
      },
      [{ name: "us", capabilities: caps }],
    )
    if (!result.ok) throw new Error(result.errors.join("\n"))
    const store = memoryStore()
    await store.put("public/status.json", JSON.stringify(publicStatus(result.config, { home: "up" }, [], now)))
    await store.put("public/page.json", JSON.stringify(publicPage(result.config, now)))
    await store.put("public/notes.json", JSON.stringify(buildNotes([], result.config, now).notes))
    return store
  }

  it("serves the theme's font from the page's own host, and reuses it once published", async () => {
    const store = await world("Inter, sans-serif")
    const { fetchImpl, asked } = fakeGoogle()
    const loadFont = cachedFonts(store, googleFonts(fetchImpl))
    const first = await buildPage({ store, clock: { now: () => now }, siteUrl: "https://status.example.com/", loadFont })
    if (!first.ok) throw new Error(first.problems.join("\n"))
    expect(first.warnings).toEqual([])
    expect(first.files["fonts/inter-1.woff2"]).toBeInstanceOf(Uint8Array)
    expect(first.files["style.css"]).toMatch(/^@font-face \{\n {2}font-family: 'Inter';/)
    expect(first.files["style.css"]).toContain("--font-sans: Inter, sans-serif, ui-sans-serif")
    await writePage(store, first.files)
    const fetched = asked.length
    const second = await buildPage({ store, clock: { now: () => now }, siteUrl: "https://status.example.com/", loadFont })
    expect(asked.length).toBe(fetched)
    expect(second.ok && second.files["style.css"]).toContain("url(fonts/inter-1.woff2)")
    expect(second.ok && second.files["fonts/inter-1.woff2"]).toBeUndefined()
  })

  it("warns, and still builds, when a font isn't available", async () => {
    const store = await world("Made Up Sans, sans-serif")
    const { fetchImpl } = fakeGoogle()
    const result = await buildPage({ store, clock: { now: () => now }, siteUrl: "https://status.example.com/", loadFont: googleFonts(fetchImpl) })
    expect(result.ok && result.warnings).toEqual(['The theme\'s font-sans "Made Up Sans" isn\'t on Google Fonts, so the page uses it only where it\'s installed.'])
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch
    const down = await buildPage({ store, clock: { now: () => now }, siteUrl: "https://status.example.com/", loadFont: googleFonts(failing) })
    expect(down.ok && down.warnings[0]).toContain("couldn't be fetched (Google Fonts answered 503)")
  })
})

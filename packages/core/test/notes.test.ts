import { describe, expect, it } from "vitest"
import {
  DECIDE_STATE_KEY,
  HISTORY_KEY,
  NOTES_KEY,
  RESULTS_FORMAT,
  STATUS_KEY,
  buildNotes,
  decide,
  inMaintenance,
  lintMarkdown,
  memoryStore,
  parseNote,
  resultsKey,
  validateConfig,
  type Alert,
  type Config,
} from "../src/index.ts"

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }
function config(): Config {
  const result = validateConfig(
    {
      components: [{ name: "Website" }, { name: "API" }],
      notifiers: [{ id: "ops", type: "webhook", secret: "HOOK" }],
      checks: [
        { id: "home", type: "http", component: "Website", url: "https://www.example.com/" },
        { id: "api", type: "http", component: "API", url: "https://api.example.com/" },
      ],
    },
    [{ name: "us", capabilities: caps }],
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  return result.config
}

const maintenance = `---
type: maintenance
title: Database upgrade
components: API
start: 2026-11-20T02:00:00Z
end: 2026-11-20T03:00:00Z
---
We're moving the API's database to a larger server. Requests may fail.

## 2026-11-20 02:40 UTC
The copy is done; switching over now.

## 2026-11-20 02:10 UTC
Copying data.
`

describe("parseNote", () => {
  it("reads the header, the summary and the timed updates, oldest first", () => {
    const { note, errors } = parseNote("notes/2026-11-20-database-upgrade.md", maintenance, config())
    expect(errors).toEqual([])
    expect(note).toEqual({
      id: "2026-11-20-database-upgrade",
      type: "maintenance",
      title: "Database upgrade",
      components: ["API"],
      start: "2026-11-20T02:00:00.000Z",
      end: "2026-11-20T03:00:00.000Z",
      detected: [],
      body: "We're moving the API's database to a larger server. Requests may fail.",
      updates: [
        { at: "2026-11-20T02:10:00.000Z", text: "Copying data." },
        { at: "2026-11-20T02:40:00.000Z", text: "The copy is done; switching over now." },
      ],
    })
  })

  it("reads an open incident that explains detected incidents", () => {
    const text = "---\ntype: incident\ntitle: Checkout errors\ncomponent: Website\nstart: 2026-11-21T09:00:00+01:00\ndetected: home-202611210800\n---\nSome payments fail. We're on it.\n"
    const { note } = parseNote("checkout.md", text, config())
    expect(note).toMatchObject({ type: "incident", start: "2026-11-21T08:00:00.000Z", detected: ["home-202611210800"] })
    expect(note?.end).toBeUndefined()
  })

  it("names the file and field for each problem, with a fix", () => {
    const text = "---\ntype: outage\ncomponents: Billing\nstart: next tuesday\ncolour: red\n---\n"
    const { note, errors } = parseNote("bad.md", text, config())
    expect(note).toBeNull()
    expect(errors.map((e) => [e.field, e.message])).toEqual([
      ["colour", "isn't a header field."],
      ["type", 'is "outage".'],
      ["title", "is missing."],
      ["components", '"Billing" isn\'t a component in the config.'],
      ["start", '"next tuesday" isn\'t a time with a zone.'],
    ])
    expect(errors.every((e) => e.file === "bad.md")).toBe(true)
  })

  it("needs an end for maintenance, after the start", () => {
    const text = "---\ntype: maintenance\ntitle: x\ncomponent: API\nstart: 2026-11-20T03:00:00Z\nend: 2026-11-20T02:00:00Z\n---\n"
    expect(parseNote("m.md", text, config()).errors.map((e) => e.field)).toEqual(["end"])
  })
})

describe("lintMarkdown", () => {
  it("warns about images without alt text, vague links, skipped headings and tables without headers", () => {
    const md = "![](diagram.png)\n\nSee [here](https://example.com/plan) or [https://example.com](https://example.com).\n\n## Impact\n\n#### Details\n\n<table><tr><td>a</td></tr></table>\n"
    expect(lintMarkdown("n.md", md).map((w) => w.field)).toEqual(["image", "link", "link", "heading", "table"])
  })

  it("is quiet for accessible Markdown", () => {
    const md = "![The API's error rate fell to zero at 02:45](rate.png)\n\nRead [the upgrade plan](https://example.com/plan).\n\n## Impact\n\n### Details\n"
    expect(lintMarkdown("n.md", md)).toEqual([])
  })
})

describe("buildNotes", () => {
  it("publishes nothing when any note has an error, and keeps warnings apart", () => {
    const result = buildNotes([{ file: "ok.md", text: maintenance }, { file: "bad.md", text: "no header" }], config(), new Date())
    expect(result.notes).toBeNull()
    expect(result.errors.map((e) => e.file)).toEqual(["bad.md"])
  })

  it("orders notes newest first", () => {
    const later = maintenance.replace(/2026-11-20/g, "2026-11-27")
    const result = buildNotes([{ file: "a.md", text: maintenance }, { file: "b.md", text: later }], config(), new Date("2026-11-15T00:00:00Z"))
    expect(result.notes?.notes.map((n) => n.id)).toEqual(["b", "a"])
    expect(inMaintenance(result.notes, new Date("2026-11-20T02:30:00Z"))).toEqual(new Set(["API"]))
    expect(inMaintenance(result.notes, new Date("2026-11-20T03:00:00Z"))).toEqual(new Set())
  })
})

describe("decide during maintenance", () => {
  function world(now: string) {
    const store = memoryStore()
    const sent: Alert[] = []
    const notes = buildNotes([{ file: "upgrade.md", text: maintenance }], config(), new Date())
    const deps = {
      config: config(),
      byRegion: { us: ["home", "api"] },
      store,
      clock: { now: () => new Date(now) },
      notifiers: [{ levels: ["alert" as const], send: async (a: Alert) => void sent.push(a) }],
    }
    const fail = async (minute: string) => {
      const at = new Date(minute)
      const results = [{ id: "api", ok: false, slow: false, failure: "status", message: "Got status 503, expected 2xx.", status: 503, timing: { totalMs: 5 } }]
      await store.put(resultsKey("us", at), JSON.stringify({ format: RESULTS_FORMAT, region: "us", startedAt: minute, finishedAt: minute, results }))
    }
    return { store, sent, deps, fail, publish: () => store.put(NOTES_KEY, JSON.stringify(notes.notes)) }
  }

  it("opens no incident and sends no alert, and shows the component as Maintenance", async () => {
    const { store, sent, deps, fail, publish } = world("2026-11-20T02:30:30Z")
    await publish()
    await fail("2026-11-20T02:28:00Z")
    await fail("2026-11-20T02:29:00Z")
    const report = await decide(deps)
    expect(report.opened).toEqual([])
    expect(report.states.api).toBe("maintenance")
    expect(sent).toEqual([])
    const status = JSON.parse((await store.get(STATUS_KEY)) ?? "")
    expect(status.components).toEqual([
      { name: "Website", state: "operational" },
      { name: "API", state: "maintenance" },
    ])
    expect(status.overall).toBe("maintenance")
  })

  it("counts an outage that outlasts the window from the window's end", async () => {
    const { deps, fail, publish } = world("2026-11-20T03:02:30Z")
    await publish()
    for (const m of ["2026-11-20T02:58:00Z", "2026-11-20T02:59:00Z", "2026-11-20T03:00:00Z", "2026-11-20T03:01:00Z"]) await fail(m)
    const report = await decide(deps)
    expect(report.opened[0]?.startedAt).toBe("2026-11-20T03:00:00.000Z")
  })

  it("leaves maintenance minutes out of the history", async () => {
    const { store, deps, publish } = world("2026-11-20T12:00:30Z")
    await publish()
    // Monitoring began before the window, so its minutes are in range.
    await store.put(DECIDE_STATE_KEY, JSON.stringify({ format: "belltower.decide/1", open: {}, since: "2026-11-01T00:00:00.000Z" }))
    await decide(deps)
    const history = JSON.parse((await store.get(HISTORY_KEY)) ?? "")
    expect(history.components[1].days.at(-1)).toMatchObject({ date: "2026-11-20", maintenanceMinutes: 60 })
  })
})

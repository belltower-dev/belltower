import { describe, expect, it } from "vitest"
import { ALERT_FORMAT, buildNotifiers, webhookNotifier, type Alert } from "../src/index.ts"

const alert: Alert = { priority: "P3", title: "Down: home (Website)", text: "home has failed in us, eu since 10:01 UTC." }
const secrets = { get: async (name: string) => (name === "HOOK_URL" ? "https://hooks.example.com/abc" : null) }
const hook = { id: "chat", type: "webhook" as const, secret: "HOOK_URL", upTo: "P4" as const }

describe("webhookNotifier", () => {
  it("posts the alert as versioned JSON to the URL in the secret", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const notifier = webhookNotifier(hook, secrets, async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(null, { status: 204 })
    })
    await notifier.send(alert)
    expect(calls[0]?.url).toBe("https://hooks.example.com/abc")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ format: ALERT_FORMAT, ...alert })
    expect(notifier.upTo).toEqual("P4")
  })

  it("fails with the status when the webhook refuses", async () => {
    const notifier = webhookNotifier(hook, secrets, async () => new Response("no", { status: 500 }))
    await expect(notifier.send(alert)).rejects.toThrow('Notifier "chat": the webhook answered 500.')
  })

  it("names the secret, never its value, when it isn't set", async () => {
    const notifier = webhookNotifier({ ...hook, secret: "MISSING" }, secrets, async () => new Response())
    await expect(notifier.send(alert)).rejects.toThrow('The secret "MISSING" for notifier "chat" isn\'t set.')
  })
})

describe("buildNotifiers", () => {
  it("refuses a type the adapter has no sender for, naming the notifier", () => {
    expect(() => buildNotifiers([{ id: "ops", type: "email", to: ["ops@example.com"], upTo: "P4" }], { secrets })).toThrow(
      'Notifier "ops" is type email, which this adapter can\'t send yet.',
    )
  })

  it("uses the adapter's factory for email and sms", () => {
    const made = buildNotifiers([{ id: "ops", type: "email", to: ["ops@example.com"], upTo: "P4" }], {
      secrets,
      others: { email: (c) => ({ upTo: c.upTo, send: async () => {} }) },
    })
    expect(made).toHaveLength(1)
  })
})

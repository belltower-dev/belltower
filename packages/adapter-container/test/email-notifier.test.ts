import { createServer, type Server, type Socket } from "node:net"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emailNotifier, smtpSettings } from "../src/index.ts"

/** Speaks just enough SMTP to accept a message, and keeps what it was sent. */
let smtp: Server
let port = 0
let refuseRecipients = false
const received: { from: string; to: string[]; data: string }[] = []

beforeAll(async () => {
  smtp = createServer((socket: Socket) => {
    let from = ""
    const to: string[] = []
    let data: string[] | null = null
    let buffer = ""
    socket.write("220 smtp.example.com ready\r\n")
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data) {
          if (line === ".") {
            received.push({ from, to: [...to], data: data.join("\n") })
            data = null
            socket.write("250 queued\r\n")
          } else data.push(line)
          continue
        }
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === "EHLO" || verb === "HELO") socket.write("250 smtp.example.com\r\n")
        else if (verb === "MAIL") (from = line), socket.write("250 ok\r\n")
        else if (verb === "RCPT") refuseRecipients ? socket.write("550 no such user\r\n") : (to.push(line), socket.write("250 ok\r\n"))
        else if (verb === "DATA") (data = []), socket.write("354 go ahead\r\n")
        else if (verb === "QUIT") socket.end("221 bye\r\n")
        else socket.write("250 ok\r\n")
      }
    })
  })
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve))
  port = (smtp.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => smtp.close(() => resolve())))

const config = { id: "ops", type: "email" as const, to: ["ops@example.com", "oncall@example.com"], upTo: "P4" as const }
const settings = () => ({ url: `smtp://127.0.0.1:${port}?ignoreTLS=true`, from: "Belltower <alerts@example.com>" })

describe("emailNotifier", () => {
  it("sends the alert as a plain-text email to every recipient", async () => {
    received.length = 0
    await emailNotifier(config, settings()).send({
      priority: "P3",
      title: "Down: home (Website)",
      text: "home has failed in us, eu since 10:01 UTC.\nGot status 503, expected 2xx.",
    })
    expect(received).toHaveLength(1)
    const mail = received[0]
    expect(mail?.from).toContain("alerts@example.com")
    expect(mail?.to.join(" ")).toContain("ops@example.com")
    expect(mail?.to.join(" ")).toContain("oncall@example.com")
    expect(mail?.data).toContain("Subject: Down: home (Website)")
    expect(mail?.data).toContain("Content-Type: text/plain")
    expect(mail?.data).toContain("Got status 503, expected 2xx.")
  })

  it("fails with the notifier's id when the server refuses", async () => {
    refuseRecipients = true
    try {
      await expect(emailNotifier(config, settings()).send({ priority: "P3", title: "Down", text: "x" })).rejects.toThrow('Notifier "ops" couldn\'t send email')
    } finally {
      refuseRecipients = false
    }
  })
})

describe("smtpSettings", () => {
  it("names the secrets that aren't set", async () => {
    expect(await smtpSettings({ get: async () => null })).toEqual({ missing: ["BELLTOWER_SMTP_URL", "BELLTOWER_EMAIL_FROM"] })
    expect(await smtpSettings({ get: async (n) => (n === "BELLTOWER_SMTP_URL" ? "smtp://x" : "a@example.com") })).toEqual({ url: "smtp://x", from: "a@example.com" })
  })
})

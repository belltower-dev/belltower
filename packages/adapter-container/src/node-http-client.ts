import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Socket } from "node:net"
import { performance } from "node:perf_hooks"
import { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import type { HttpClient, HttpTiming } from "@belltower/core"

/*
 * An HttpClient on node:http and node:https. Unlike fetch, it can skip
 * certificate verification (verifyTls: false) and it reports DNS, connect
 * and TLS times, so the container adapter declares skipTlsVerify and
 * timingBreakdown. Each request opens a fresh connection, so the timings
 * measure a real first visit.
 */

const MAX_REDIRECTS = 20

type Phases = Pick<HttpTiming, "dnsMs" | "connectMs" | "tlsMs">

export function nodeHttpClient(): HttpClient {
  return {
    async fetch(request, { verifyTls }) {
      let url = new URL(request.url)
      let method = request.method
      let body: Buffer | undefined = method === "GET" || method === "HEAD" ? undefined : Buffer.from(await request.arrayBuffer())
      const headers = new Headers(request.headers)
      if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip, deflate, br")

      for (let hop = 0; ; hop++) {
        const { message, phases } = await send(url, method, headers, body, verifyTls, request.signal)
        const status = message.statusCode ?? 0
        const location = message.headers.location
        if (request.redirect === "follow" && status >= 300 && status < 400 && location) {
          message.resume()
          if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`)
          const next = new URL(location, url)
          if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
            method = "GET"
            body = undefined
            headers.delete("content-type")
            headers.delete("content-length")
          }
          if (next.origin !== url.origin) headers.delete("authorization")
          url = next
          continue
        }
        return { response: toResponse(message, method, request.signal), timing: phases }
      }
    },
  }
}

function send(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  verifyTls: boolean,
  signal: AbortSignal,
): Promise<{ message: IncomingMessage; phases: Phases }> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    const marks: { lookup?: number; connect?: number; secure?: number } = {}
    const outgoing: Record<string, string> = {}
    headers.forEach((value, name) => (outgoing[name] = value))
    if (body) outgoing["content-length"] = String(body.length)

    const options = { method, headers: outgoing, signal, agent: false as const }
    const req =
      url.protocol === "https:"
        ? httpsRequest(url, { ...options, rejectUnauthorized: verifyTls, servername: url.hostname })
        : httpRequest(url, options)

    req.on("socket", (socket: Socket) => {
      socket.once("lookup", () => (marks.lookup = performance.now()))
      socket.once("connect", () => (marks.connect = performance.now()))
      socket.once("secureConnect", () => (marks.secure = performance.now()))
    })
    req.on("response", (message) => {
      const ms = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined ? Math.round(b - a) : undefined)
      const phases: Phases = {}
      const dns = ms(start, marks.lookup)
      const connect = ms(marks.lookup ?? start, marks.connect)
      const tls = ms(marks.connect, marks.secure)
      if (dns !== undefined) phases.dnsMs = dns
      if (connect !== undefined) phases.connectMs = connect
      if (tls !== undefined) phases.tlsMs = tls
      resolve({ message, phases })
    })
    req.on("error", reject)
    req.end(body)
  })
}

const NULL_BODY = new Set([101, 103, 204, 205, 304])

function toResponse(message: IncomingMessage, method: string, signal: AbortSignal): Response {
  const status = message.statusCode ?? 0
  const headers = new Headers()
  const raw = message.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) headers.append(raw[i] ?? "", raw[i + 1] ?? "")

  if (method === "HEAD" || NULL_BODY.has(status)) {
    message.resume()
    return new Response(null, { status, headers })
  }
  let stream: Readable = message
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase()
  if (encoding === "gzip" || encoding === "x-gzip") stream = message.pipe(createGunzip())
  else if (encoding === "deflate") stream = message.pipe(createInflate())
  else if (encoding === "br") stream = message.pipe(createBrotliDecompress())
  if (stream !== message) {
    message.on("error", (e) => stream.destroy(e))
    headers.delete("content-encoding")
    headers.delete("content-length")
  }
  signal.addEventListener("abort", () => stream.destroy(new Error("aborted")), { once: true })
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers })
}

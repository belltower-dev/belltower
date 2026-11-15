/*
 * AWS Signature Version 4 with Web Crypto only, so S3-compatible storage
 * works from every runtime: Node, Lambda, Workers. Covers what the S3 Store
 * needs (header signing with a hashed payload), not the whole AWS API.
 */

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignInput {
  method: string
  url: URL
  /** Headers to sign and send. host, x-amz-date and x-amz-content-sha256 are added. */
  headers: Record<string, string>
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string
  region: string
  service: string
  credentials: AwsCredentials
  date: Date
}

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return crypto.subtle.sign("HMAC", k, encoder.encode(data))
}

/** RFC 3986 encoding, as SigV4 wants it. `/` is kept in paths. */
export function uriEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded
}

/** Returns the headers to send, Authorization included. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const amzDate = input.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": input.payloadHash,
  }
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken

  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("")
  const signedHeaders = names.join(";")
  const params: (readonly [string, string])[] = []
  input.url.searchParams.forEach((v, k) => params.push([uriEncode(k), uriEncode(v)]))
  const query = params
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&")
  // The URL's pathname is already percent-encoded; decode and re-encode so it matches SigV4's rules exactly.
  const path = input.url.pathname.split("/").map((s) => uriEncode(decodeURIComponent(s))).join("/") || "/"
  const canonical = [input.method, path, query, canonicalHeaders, signedHeaders, input.payloadHash].join("\n")

  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n")
  let key = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), day)
  for (const part of [input.region, input.service, "aws4_request"]) key = await hmac(key, part)
  const signature = hex(await hmac(key, toSign))

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  delete headers.host
  return headers
}

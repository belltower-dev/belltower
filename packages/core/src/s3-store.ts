import type { Store } from "./ports.ts"
import { sha256Hex, signRequest, uriEncode, type AwsCredentials } from "./sigv4.ts"

/*
 * A Store on any S3-compatible object storage, over fetch with SigV4: AWS
 * S3, Cloudflare R2, Google Cloud Storage's XML API, MinIO. All give the
 * read-after-write consistency the spec requires.
 */

export interface S3StoreOptions {
  /** Such as https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://localhost:9000 */
  endpoint: string
  bucket: string
  /** The signing region: the bucket's region on AWS, "auto" on R2. */
  region: string
  credentials: AwsCredentials
  /** Keys are stored under this prefix in the bucket, so one bucket can hold several deployments. */
  prefix?: string
  /** Put the bucket in the path. Defaults to true except on amazonaws.com, which uses the bucket's own host name. */
  pathStyle?: boolean
  fetch?: typeof fetch
  /** For tests. */
  now?: () => Date
}

export function s3Store(options: S3StoreOptions): Store {
  const endpoint = new URL(options.endpoint)
  const pathStyle = options.pathStyle ?? !endpoint.hostname.endsWith("amazonaws.com")
  const prefix = options.prefix ? options.prefix.replace(/\/*$/, "/") : ""
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const now = options.now ?? (() => new Date())

  const base = (): URL => {
    const url = new URL(endpoint)
    if (pathStyle) url.pathname = `${url.pathname.replace(/\/$/, "")}/${uriEncode(options.bucket)}/`
    else url.hostname = `${options.bucket}.${url.hostname}`
    return url
  }
  const objectUrl = (key: string): URL => {
    const url = base()
    url.pathname = `${url.pathname}${uriEncode(prefix + key, true)}`
    return url
  }

  async function send(method: string, url: URL, body?: string | Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
    const payload = body ?? ""
    const headers = await signRequest({
      method,
      url,
      headers: extra,
      payloadHash: await sha256Hex(payload),
      region: options.region,
      service: "s3",
      credentials: options.credentials,
      date: now(),
    })
    return doFetch(url, { method, headers, ...(body !== undefined ? { body: body as BodyInit } : {}) })
  }

  async function fail(action: string, key: string, response: Response): Promise<never> {
    const text = await response.text()
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
    throw new Error(`S3 ${action} of "${key}" in bucket "${options.bucket}" failed with ${response.status}${code ? ` ${code}` : ""}${message ? `: ${decodeXml(message)}` : ""}.`)
  }

  return {
    async get(key) {
      const response = await send("GET", objectUrl(key))
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) return fail("get", key, response)
      return response.text()
    },

    async put(key, body, opts) {
      const response = await send("PUT", objectUrl(key), body, { "content-type": opts?.contentType ?? "application/octet-stream" })
      if (!response.ok) return fail("put", key, response)
      await response.body?.cancel()
    },

    async list(listPrefix) {
      const keys: string[] = []
      let token: string | null = null
      do {
        const url = base()
        url.searchParams.set("list-type", "2")
        url.searchParams.set("prefix", prefix + listPrefix)
        if (token) url.searchParams.set("continuation-token", token)
        const response = await send("GET", url)
        if (!response.ok) return fail("list", listPrefix, response)
        const xml = await response.text()
        for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<\/Contents>/g)) {
          keys.push(decodeXml(m[1] ?? "").slice(prefix.length))
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || null : null
      } while (token)
      return keys.sort()
    },
  }
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
    if (named[e.toLowerCase()]) return named[e.toLowerCase()] ?? ""
    return String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  })
}

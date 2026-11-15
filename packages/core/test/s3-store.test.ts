import { describe, expect, it } from "vitest"
import { s3Store } from "../src/index.ts"
import { storeContract } from "./contracts/store.ts"

/** An in-memory S3 that checks each request is signed and pages lists two keys at a time. */
function fakeS3(opts: { pathStyle: boolean } = { pathStyle: true }) {
  const buckets = new Map<string, Map<string, string>>()
  const seen: { method: string; url: string; headers: Headers }[] = []
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

  const handler: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    seen.push({ method: init?.method ?? "GET", url: url.href, headers })
    if (!/^AWS4-HMAC-SHA256 Credential=TESTKEY\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(headers.get("authorization") ?? "")) {
      return new Response("<Error><Code>AccessDenied</Code><Message>Unsigned request</Message></Error>", { status: 403 })
    }
    let bucket: string
    let key: string
    if (opts.pathStyle) {
      const [, b = "", ...rest] = url.pathname.split("/")
      bucket = decodeURIComponent(b)
      key = decodeURIComponent(rest.join("/"))
    } else {
      bucket = url.hostname.split(".")[0] ?? ""
      key = decodeURIComponent(url.pathname.slice(1))
    }
    const objects = buckets.get(bucket) ?? new Map<string, string>()
    buckets.set(bucket, objects)

    if (init?.method === "PUT") {
      objects.set(key, String(init.body ?? ""))
      return new Response(null, { status: 200 })
    }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = Number(url.searchParams.get("continuation-token") ?? 0)
      const page = all.slice(start, start + 2)
      const more = start + 2 < all.length
      const body = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${page.map((k) => `<Contents><Key>${xml(k)}</Key><Size>1</Size></Contents>`).join("")}${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`
      return new Response(body, { status: 200 })
    }
    const value = objects.get(key)
    if (value === undefined) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
    return new Response(value, { status: 200 })
  }
  return { handler, seen, buckets }
}

const credentials = { accessKeyId: "TESTKEY", secretAccessKey: "testsecret" }

storeContract("S3, path style", async () =>
  s3Store({ endpoint: "http://localhost:9000", bucket: "belltower", region: "auto", credentials, fetch: fakeS3().handler }),
)

storeContract("S3, under a prefix", async () =>
  s3Store({ endpoint: "http://localhost:9000", bucket: "shared", region: "auto", credentials, prefix: "deployments/demo", fetch: fakeS3().handler }),
)

describe("s3Store", () => {
  it("puts the bucket in the host name on amazonaws.com", async () => {
    const s3 = fakeS3({ pathStyle: false })
    const store = s3Store({ endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "belltower", region: "auto", credentials, fetch: s3.handler })
    await store.put("public/status.json", "{}", { contentType: "application/json" })
    expect(s3.seen[0]?.url).toBe("https://belltower.s3.us-east-1.amazonaws.com/public/status.json")
    expect(s3.seen[0]?.headers.get("content-type")).toBe("application/json")
    expect(await store.get("public/status.json")).toBe("{}")
  })

  it("stores keys under the prefix and lists them without it", async () => {
    const s3 = fakeS3()
    const store = s3Store({ endpoint: "http://localhost:9000", bucket: "shared", region: "auto", credentials, prefix: "demo/", fetch: s3.handler })
    await store.put("incidents/a.json", "{}")
    expect([...(s3.buckets.get("shared")?.keys() ?? [])]).toEqual(["demo/incidents/a.json"])
    expect(await store.list("incidents/")).toEqual(["incidents/a.json"])
  })

  it("reads keys with characters XML and URLs escape", async () => {
    const store = s3Store({ endpoint: "http://localhost:9000", bucket: "b", region: "auto", credentials, fetch: fakeS3().handler })
    await store.put("notes/a&b c+d.md", "x")
    expect(await store.list("notes/")).toEqual(["notes/a&b c+d.md"])
    expect(await store.get("notes/a&b c+d.md")).toBe("x")
  })

  it("says which key, bucket and S3 error code when a request fails", async () => {
    const store = s3Store({ endpoint: "http://localhost:9000", bucket: "belltower", region: "auto", credentials: { accessKeyId: "WRONG", secretAccessKey: "x" }, fetch: fakeS3().handler })
    await expect(store.get("public/status.json")).rejects.toThrow('S3 get of "public/status.json" in bucket "belltower" failed with 403 AccessDenied: Unsigned request.')
  })
})

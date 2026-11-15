import { describe, expect, it } from "vitest"
import { sha256Hex, signRequest, uriEncode } from "../src/sigv4.ts"

/*
 * The worked examples from Amazon S3's "Signature Calculations for the
 * Authorization Header" documentation, with its example credentials.
 */
const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }
const date = new Date("2013-05-24T00:00:00Z")
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const signature = (headers: Record<string, string>) => /Signature=([0-9a-f]+)/.exec(headers.authorization ?? "")?.[1]

describe("signRequest", () => {
  it("matches AWS's GET Object example", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY,
      region: "us-east-1",
      service: "s3",
      credentials,
      date,
    })
    expect(signature(headers)).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")
    expect(headers.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date")
  })

  it("matches AWS's PUT Object example", async () => {
    const body = "Welcome to Amazon S3."
    const headers = await signRequest({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: await sha256Hex(body),
      region: "us-east-1",
      service: "s3",
      credentials,
      date,
    })
    expect(signature(headers)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd")
  })

  it("matches AWS's list objects example, with a query string", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      headers: {},
      payloadHash: EMPTY,
      region: "us-east-1",
      service: "s3",
      credentials,
      date,
    })
    expect(signature(headers)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7")
  })

  it("adds the session token for temporary credentials", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/a"),
      headers: {},
      payloadHash: EMPTY,
      region: "us-east-1",
      service: "s3",
      credentials: { ...credentials, sessionToken: "token123" },
      date,
    })
    expect(headers["x-amz-security-token"]).toBe("token123")
    expect(headers.authorization).toContain("x-amz-security-token")
  })
})

describe("uriEncode", () => {
  it("encodes what RFC 3986 reserves, keeping slashes in paths", () => {
    expect(uriEncode("a b/c*(d)!'")).toBe("a%20b%2Fc%2A%28d%29%21%27")
    expect(uriEncode("results/us/1007.json", true)).toBe("results/us/1007.json")
  })
})

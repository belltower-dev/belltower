import { describe, expect, it } from "vitest"
import { s3Store, sha256Hex, signRequest } from "../src/index.ts"
import { storeContract } from "./contracts/store.ts"

/*
 * Runs the Store contract against real S3-compatible storage, such as MinIO
 * in CI. Skipped unless BELLTOWER_S3_TEST_ENDPOINT is set:
 *
 *   BELLTOWER_S3_TEST_ENDPOINT=http://localhost:9000
 *   BELLTOWER_S3_TEST_KEY, BELLTOWER_S3_TEST_SECRET
 *   BELLTOWER_S3_TEST_REGION (default us-east-1)
 *
 * It creates one bucket per run.
 */

declare const process: { env: Record<string, string | undefined> } | undefined
const env = typeof process === "undefined" ? {} : process.env
const endpoint = env.BELLTOWER_S3_TEST_ENDPOINT
const credentials = { accessKeyId: env.BELLTOWER_S3_TEST_KEY ?? "", secretAccessKey: env.BELLTOWER_S3_TEST_SECRET ?? "" }
const region = env.BELLTOWER_S3_TEST_REGION ?? "us-east-1"
const bucket = `belltower-test-${Date.now().toString(36)}`

describe.skipIf(!endpoint)("S3 against a real server", () => {
  let run = 0

  it("creates the test bucket", async () => {
    const url = new URL(`${endpoint}/${bucket}`)
    const headers = await signRequest({ method: "PUT", url, headers: {}, payloadHash: await sha256Hex(""), region, service: "s3", credentials, date: new Date() })
    const response = await fetch(url, { method: "PUT", headers })
    expect(response.ok, await response.text()).toBe(true)
  })

  // Each contract test gets its own prefix, so each starts empty in the one bucket.
  storeContract("real S3", async () => s3Store({ endpoint: endpoint ?? "", bucket, region, credentials, prefix: `run-${++run}` }))

  it("refuses wrong credentials with the S3 error code", async () => {
    const store = s3Store({ endpoint: endpoint ?? "", bucket, region, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: "wrong" } })
    await expect(store.get("a.json")).rejects.toThrow(/failed with 403 SignatureDoesNotMatch/)
  })
})

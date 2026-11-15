import { describe, expect, it } from "vitest"
import { runCli, storeFromFlag, type Io } from "../src/index.ts"

describe("storeFromFlag", () => {
  it("treats anything but s3:// as a folder", () => {
    expect(storeFromFlag("belltower-data", {})).toBeTruthy()
  })

  it("builds an S3 store from the environment", () => {
    const env = { AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1" }
    expect(storeFromFlag("s3://my-bucket/deployments/demo", env)).toBeTruthy()
  })

  it("names the missing settings, never asking for them as flags", () => {
    expect(() => storeFromFlag("s3://my-bucket", {})).toThrow("An s3:// store needs AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, which aren't set.")
  })

  it("refuses a bucket name S3 wouldn't accept", () => {
    expect(() => storeFromFlag("s3://My_Bucket", { AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "auto" })).toThrow('"My_Bucket" isn\'t a valid bucket name.')
  })
})

describe("the CLI with an s3:// store", () => {
  it("exits 3 with the missing settings and their path", async () => {
    const out: string[] = []
    const io: Io = { out: (l) => out.push(l), err: () => {}, env: {} }
    const code = await runCli(["validate", "--config", "/nowhere.json", "--json"], io)
    expect(code).toBe(3)
    const runCode = await runCli(["run", "decide", "--store", "s3://my-bucket", "--config", new URL("../../../examples/local/belltower.config.json", import.meta.url).pathname, "--json"], io)
    expect(runCode).toBe(3)
    expect(JSON.parse(out.at(-1) ?? "").errors[0]).toMatchObject({ code: "missing-secret", path: "--store" })
  })
})

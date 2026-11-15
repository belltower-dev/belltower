import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { storeContract } from "@belltower/core/contracts"
import { describe, expect, it } from "vitest"
import { localFolderStore } from "../src/index.ts"

const freshDir = () => mkdtemp(join(tmpdir(), "belltower-store-"))

storeContract("local folder", async () => localFolderStore(await freshDir()))

describe("localFolderStore", () => {
  it("writes each key as a file under the root", async () => {
    const root = await freshDir()
    await localFolderStore(root).put("results/us/2026/11/15/1007.json", "{}")
    expect(await readdir(join(root, "results/us/2026/11/15"))).toEqual(["1007.json"])
  })

  it("leaves no temporary files behind", async () => {
    const root = await freshDir()
    const store = localFolderStore(root)
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.put("heartbeats/nightly.json", String(i))))
    expect(await readdir(join(root, "heartbeats"))).toEqual(["nightly.json"])
  })

  it("skips temporary files another writer left mid-write", async () => {
    const root = await freshDir()
    await mkdir(join(root, "incidents"))
    await writeFile(join(root, "incidents", ".belltower-tmp-123"), "partial")
    await writeFile(join(root, "incidents", "a.json"), "{}")
    expect(await localFolderStore(root).list("incidents/")).toEqual(["incidents/a.json"])
  })

  it("refuses keys that would leave the root", async () => {
    const store = localFolderStore(await freshDir())
    for (const key of ["../outside.json", "results/../../outside.json", "/etc/passwd", "a//b", "a\\b", ""]) {
      await expect(store.put(key, "x"), key).rejects.toThrow("isn't allowed")
      await expect(store.get(key), key).rejects.toThrow("isn't allowed")
    }
    await expect(store.list("../")).rejects.toThrow("isn't allowed")
  })

  it("lists nothing when the root doesn't exist yet", async () => {
    const store = localFolderStore(join(await freshDir(), "not-yet"))
    expect(await store.list("")).toEqual([])
    expect(await store.get("public/status.json")).toBeNull()
  })

  it("treats a prefix naming a file's folder path as a file, not a folder", async () => {
    const store = localFolderStore(await freshDir())
    await store.put("public/status.json", "{}")
    expect(await store.list("public/status.json/")).toEqual([])
  })
})

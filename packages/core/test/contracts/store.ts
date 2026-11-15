import { describe, expect, it } from "vitest"
import type { Store } from "../../src/ports.ts"

/*
 * What every Store must do (docs/spec.md, "What the platform supplies" and
 * "Storage"). Each adapter runs this against its own stores:
 *
 *   storeContract("local folder", async () => localFolderStore(await freshDir()))
 *
 * `make` must return an empty store each time it's called.
 */
export function storeContract(name: string, make: () => Promise<Store>) {
  describe(`Store contract: ${name}`, () => {
    it("returns null for a key that was never written", async () => {
      const store = await make()
      expect(await store.get("results/us/2026/11/15/1007.json")).toBeNull()
    })

    it("reads back what it just wrote", async () => {
      const store = await make()
      const body = JSON.stringify({ format: "belltower.results/1", note: "Grüße, 東京 ✓" })
      await store.put("results/us/2026/11/15/1007.json", body, { contentType: "application/json" })
      expect(await store.get("results/us/2026/11/15/1007.json")).toBe(body)
    })

    it("replaces a key's contents on a second write", async () => {
      const store = await make()
      await store.put("heartbeats/nightly.json", "first")
      await store.put("heartbeats/nightly.json", "second")
      expect(await store.get("heartbeats/nightly.json")).toBe("second")
    })

    it("keeps an empty body distinct from a missing key", async () => {
      const store = await make()
      await store.put("public/empty.txt", "")
      expect(await store.get("public/empty.txt")).toBe("")
    })

    it("lists every key under a prefix, at any depth, in lexical order", async () => {
      const store = await make()
      const keys = [
        "results/us/2026/11/15/1008.json",
        "results/us/2026/11/14/2359.json",
        "results/us/2026/11/15/1007.json",
        "results/eu/2026/11/15/1007.json",
        "incidents/a.json",
      ]
      for (const key of keys) await store.put(key, "{}")
      expect(await store.list("results/us/")).toEqual([
        "results/us/2026/11/14/2359.json",
        "results/us/2026/11/15/1007.json",
        "results/us/2026/11/15/1008.json",
      ])
    })

    it("matches a prefix that ends partway through a name", async () => {
      const store = await make()
      await store.put("results/us/2026/11/15/1007.json", "{}")
      await store.put("results/use/2026/11/15/1007.json", "{}")
      await store.put("results/eu/2026/11/15/1007.json", "{}")
      expect(await store.list("results/us")).toEqual(["results/us/2026/11/15/1007.json", "results/use/2026/11/15/1007.json"])
      expect(await store.list("results/us/2026/11/15/100")).toEqual(["results/us/2026/11/15/1007.json"])
    })

    it("lists everything for an empty prefix, and nothing for an unused one", async () => {
      const store = await make()
      await store.put("b/one.json", "{}")
      await store.put("a/two.json", "{}")
      expect(await store.list("")).toEqual(["a/two.json", "b/one.json"])
      expect(await store.list("incidents/")).toEqual([])
    })

    it("sees every write from parallel puts", async () => {
      const store = await make()
      const keys = Array.from({ length: 20 }, (_, i) => `results/r${i}/2026/11/15/1007.json`)
      await Promise.all(keys.map((key, i) => store.put(key, String(i))))
      expect(await store.list("results/")).toEqual([...keys].sort())
      expect(await Promise.all(keys.map((key) => store.get(key)))).toEqual(keys.map((_, i) => String(i)))
    })
  })
}

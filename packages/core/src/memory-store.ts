import type { Store } from "./ports.ts"

/**
 * A Store held in memory. For tests and single-process demos: nothing
 * survives a restart and nothing is shared between processes.
 */
export function memoryStore(): Store {
  const files = new Map<string, string | Uint8Array>()
  const decoder = new TextDecoder()
  return {
    async get(key) {
      const body = files.get(key)
      return body === undefined ? null : typeof body === "string" ? body : decoder.decode(body)
    },
    async put(key, body) {
      files.set(key, body)
    },
    async list(prefix) {
      return [...files.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
  }
}

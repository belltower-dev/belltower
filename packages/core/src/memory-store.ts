import type { Store } from "./ports.ts"

/**
 * A Store held in memory. For tests and single-process demos: nothing
 * survives a restart and nothing is shared between processes.
 */
export function memoryStore(): Store {
  const files = new Map<string, string>()
  return {
    async get(key) {
      return files.get(key) ?? null
    },
    async put(key, body) {
      files.set(key, body)
    },
    async list(prefix) {
      return [...files.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
  }
}

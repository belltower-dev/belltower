import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Store } from "@belltower/core"

/*
 * A Store in a folder on disk, for local runs, tests and single-machine
 * deployments. Each key is a file under the root. Writes go to a temporary
 * file and are renamed into place, so a reader never sees half a file.
 * Content types aren't stored; a static host infers them from the extension.
 *
 * Every process must share the folder (one machine or a shared volume) for
 * regions to see each other's results.
 */

/** Temporary files start with this and are left out of list(). */
const TEMP = ".belltower-tmp-"

export function localFolderStore(root: string): Store {
  const base = resolve(root)

  function pathFor(key: string): string {
    const parts = key.split("/")
    if (key === "" || key.startsWith("/") || key.includes("\\") || parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith(TEMP))) {
      throw new Error(`Store key "${key}" isn't allowed: use "/"-separated names with no empty, "." or ".." parts.`)
    }
    return join(base, ...parts)
  }

  return {
    async get(key) {
      try {
        return await readFile(pathFor(key), "utf8")
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
    },

    async put(key, body) {
      const path = pathFor(key)
      await mkdir(dirname(path), { recursive: true })
      const temp = join(dirname(path), `${TEMP}${randomUUID()}`)
      try {
        await writeFile(temp, body, typeof body === "string" ? "utf8" : undefined)
        await rename(temp, path)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
    },

    async list(prefix) {
      // Start from the deepest folder the prefix names in full, then filter.
      const cut = prefix.lastIndexOf("/")
      const folder = cut === -1 ? "" : prefix.slice(0, cut)
      if (folder !== "") pathFor(folder)
      const keys: string[] = []
      await walk(folder === "" ? base : join(base, ...folder.split("/")), folder, keys)
      return keys.filter((key) => key.startsWith(prefix)).sort()
    },
  }
}

async function walk(dir: string, keyPrefix: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error) || isNotDir(error)) return
    throw error
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(TEMP)) return
      const key = keyPrefix === "" ? entry.name : `${keyPrefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), key, out)
      else if (entry.isFile()) out.push(key)
    }),
  )
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

function isNotDir(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOTDIR"
}


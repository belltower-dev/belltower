import { memoryStore } from "../src/index.ts"
import { storeContract } from "./contracts/store.ts"

storeContract("memory", async () => memoryStore())

import { describe, expect, it } from "vitest"
import { snsNotifier, ssmSecrets, type AwsContext } from "../src/index.ts"

function ctx(handler: typeof fetch): AwsContext {
  return { region: "us-east-1", credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" }, fetch: handler }
}

describe("ssmSecrets", () => {
  it("prefers environment variables, then reads SSM under the prefix, and caches", async () => {
    const names: string[] = []
    const secrets = ssmSecrets(
      ctx(async (_url, init) => {
        const name = (JSON.parse(String(init?.body)) as { Name: string }).Name
        names.push(name)
        return Response.json({ Parameter: { Value: `value of ${name}` } })
      }),
      { FROM_ENV: "env value" },
      "/belltower",
    )
    expect(await secrets.get("FROM_ENV")).toBe("env value")
    expect(await secrets.get("HOOK_URL")).toBe("value of /belltower/HOOK_URL")
    expect(await secrets.get("HOOK_URL")).toBe("value of /belltower/HOOK_URL")
    expect(names).toEqual(["/belltower/HOOK_URL"])
  })

  it("returns null for a parameter that doesn't exist, and throws on other errors", async () => {
    const missing = ssmSecrets(ctx(async () => Response.json({ __type: "com.amazonaws.ssm#ParameterNotFound" }, { status: 400 })), {}, "/b/")
    expect(await missing.get("NOPE")).toBeNull()
    const denied = ssmSecrets(ctx(async () => Response.json({ __type: "com.amazon.coral.service#AccessDeniedException", message: "not allowed" }, { status: 400 })), {}, "/b/")
    await expect(denied.get("X")).rejects.toThrow("ssm answered 400 AccessDeniedException: not allowed")
  })

  it("reads only the environment without a prefix", async () => {
    const secrets = ssmSecrets(ctx(async () => { throw new Error("should not call SSM") }), {}, undefined)
    expect(await secrets.get("ANYTHING")).toBeNull()
  })
})

describe("snsNotifier", () => {
  it("texts every number, and reports how many failed without stopping the rest", async () => {
    const sent: string[] = []
    const notifier = snsNotifier(
      { id: "pager", type: "sms", to: ["+15555550100", "+15555550101"], levels: ["critical"] },
      ctx(async (_url, init) => {
        const number = new URLSearchParams(String(init?.body)).get("PhoneNumber") ?? ""
        if (number.endsWith("01")) return new Response("<Error><Code>InvalidParameter</Code><Message>bad number</Message></Error>", { status: 400 })
        sent.push(number)
        return new Response("<PublishResponse/>")
      }),
    )
    await expect(notifier.send({ level: "critical", title: "Down: home (Website)", text: "line one\nline two" })).rejects.toThrow(
      'Notifier "pager" couldn\'t send 1 of 2 texts through SNS: sns answered 400 InvalidParameter: bad number',
    )
    expect(sent).toEqual(["+15555550100"])
  })
})

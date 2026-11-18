// SPDX-License-Identifier: MIT
// Discovery not answering, or refusing, never ends records: it keeps serving, says why, and asks again; a heartbeat
// discovery answers 404 for (it restarted and lost this vessel) registers it again. Through a real records process.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freePort, healthy, run, until } from "./harness"

type Seen = { path: string; at: number; body: any }
let stop: () => void = () => {}
afterEach(() => stop())

// A discovery stand-in on a fixed port that can be taken down and brought back, answering each path as `answer` says.
const discoveryAt = (port: number) => {
  const seen: Seen[] = []
  let answer = (path: string): Response => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 100 } : { ok: true })
  let server: ReturnType<typeof Bun.serve> | undefined
  const up = () => { server = Bun.serve({ port, fetch: async (req) => {
    const path = new URL(req.url).pathname
    seen.push({ path, at: Date.now(), body: await req.json().catch(() => null) })
    return answer(path)
  } }) }
  up()
  return {
    url: `http://127.0.0.1:${port}`, seen, up,
    down: () => { server?.stop(true); server = undefined },
    answering: (f: (path: string) => Response) => { answer = f },
  }
}

const records = async (first?: (path: string) => Response) => {
  const dport = freePort()
  const discovery = discoveryAt(dport)
  if (first) discovery.answering(first)
  const dir = mkdtempSync(join(tmpdir(), "records-beat-"))
  const port = freePort()
  const vessel = run("src/index.ts", {
    RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: String(port), DISCOVERY_URL: discovery.url,
    RECORDS_ENDPOINT: `http://127.0.0.1:${port}`, RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://127.0.0.1:1", METABOB_API_KEY: "node-key-for-test",
  })
  let exited: number | null = null
  vessel.exited.then((c) => { exited = c })
  // what it says on stderr, read as it is written: each "asking again in N s" names the wait it is about to take
  let err = ""
  ;(async () => {
    const rd = (vessel.stderr as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    for (;;) { const { value, done } = await rd.read(); if (done) break; err += dec.decode(value) }
  })()
  const waits = (path: string): number[] => [...err.matchAll(new RegExp(`${path} [^\\n]*asking again in (\\d+) s`, "g"))].map((m) => Number(m[1]))
  stop = () => { vessel.kill(); discovery.down(); rmSync(dir, { recursive: true, force: true }) }
  await healthy(port)
  const after = (path: string, n: number) => discovery.seen.filter((s) => s.path === path).length >= n
  return { discovery, port, waits, alive: () => exited === null, count: (path: string) => discovery.seen.filter((s) => s.path === path).length, after }
}
const OK = (path: string) => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 100 } : { ok: true })

describe("discovery not answering, or refusing, never ends records", () => {
  test("[MUST-FAIL] discovery gone (no answer at all): records stays up, and beats again once it is back", async () => {
    const r = await records()
    await until(() => r.after("/heartbeat", 1), "a first heartbeat")
    r.discovery.down()
    await Bun.sleep(1500) // past one heartbeat with no answer
    expect(r.alive()).toBe(true)
    expect((await fetch(`http://127.0.0.1:${r.port}/health`)).ok).toBe(true)
    const before = r.count("/heartbeat")
    r.discovery.up()
    await until(() => r.count("/heartbeat") > before, "a heartbeat after discovery came back")
    expect(r.alive()).toBe(true)
    expect(r.count("/register")).toBe(1) // no answer is not discovery forgetting it: it beats again, never registers again
  }, 20_000)
  test("[MUST-FAIL] a heartbeat refused (503): records stays up, and beats again once it is answered", async () => {
    const r = await records()
    await until(() => r.after("/heartbeat", 1), "a first heartbeat")
    r.discovery.answering((path) => path === "/heartbeat" ? new Response("validator unreachable", { status: 503 }) : OK(path))
    const before = r.count("/heartbeat")
    await until(() => r.count("/heartbeat") > before, "a refused heartbeat")
    await Bun.sleep(300)
    expect(r.alive()).toBe(true)
    r.discovery.answering(OK)
    const refused = r.count("/heartbeat")
    await until(() => r.count("/heartbeat") > refused + 1, "heartbeats answered again")
    expect(r.alive()).toBe(true)
  }, 20_000)
  test("[MUST-FAIL] a heartbeat discovery answers 404 for (it lost this vessel): records registers again", async () => {
    const r = await records()
    await until(() => r.after("/heartbeat", 1), "a first heartbeat")
    expect(r.count("/register")).toBe(1)
    let lost = true
    r.discovery.answering((path) => path === "/heartbeat" && lost ? new Response("unknown vessel", { status: 404 }) : (path === "/register" ? ((lost = false), OK(path)) : OK(path)))
    await until(() => r.count("/register") >= 2, "a second register")
    const back = r.count("/heartbeat")
    await until(() => r.count("/heartbeat") > back, "a heartbeat after registering again")
    expect(r.alive()).toBe(true)
    const regs = r.discovery.seen.filter((x) => x.path === "/register")
    expect([regs[1].body?.vesselId, regs[1].body?.shapes?.length > 0]).toEqual(["records-test", true])
    expect(regs[1].body).toEqual(regs[0].body) // registered again as at start, every shape it serves
    // the first heartbeat after that register, by arrival (two posts can share a millisecond)
    const next = r.discovery.seen.slice(r.discovery.seen.indexOf(regs[1]) + 1).find((x) => x.path === "/heartbeat")
    expect(next !== undefined && next.at - regs[1].at < 500).toBe(true) // and it beats at once, not after a retry wait
  }, 20_000)
  test("[MUST-FAIL] a register refused at start is asked again, not given up on: records serves, and registers once answered", async () => {
    let refusals = 2
    const r = await records((path) => path === "/register" && refusals-- > 0 ? new Response("not now", { status: 503 }) : OK(path))
    await until(() => r.count("/register") >= 3, "a third register")
    await until(() => r.after("/heartbeat", 1), "a first heartbeat")
    expect(r.alive()).toBe(true)
  }, 20_000)
  test("[MUST-FAIL] the schedule doubles from a second to a minute, and holds there", async () => {
    const { AGAIN_MAX_MS, AGAIN_MS, again } = await import("../src/again")
    const seen = [AGAIN_MS]
    while (seen.length < 9) seen.push(again(seen[seen.length - 1]))
    expect([seen, AGAIN_MAX_MS]).toEqual([[1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000], 60_000])
  })
  test("[MUST-FAIL] refused, it asks again on that schedule, never at once: two refusals take three asks over three seconds", async () => {
    let refusals = 2
    const r = await records((path) => path === "/register" && refusals-- > 0 ? new Response("not now", { status: 503 }) : OK(path))
    await until(() => r.after("/heartbeat", 1), "a first heartbeat")
    const asks = r.discovery.seen.filter((x) => x.path === "/register")
    expect([asks.length, r.waits("/register")]).toEqual([3, [1, 2]])
    expect(asks[2].at - asks[0].at).toBeGreaterThanOrEqual(2900)
  }, 20_000)
  test("[MUST-FAIL] the wait starts again at a second once discovery has answered", async () => {
    const r = await records()
    await until(() => r.after("/heartbeat", 1), "a first heartbeat")
    const from = r.discovery.seen.length
    const script = ["503", "503", "ok", "503"]
    r.discovery.answering((path) => path !== "/heartbeat" ? OK(path) : (script.shift() ?? "ok") === "ok" ? OK(path) : new Response("not now", { status: 503 }))
    for (let i = 0; i < 200 && r.waits("/heartbeat").length < 3; i++) await Bun.sleep(50)
    expect(r.waits("/heartbeat").slice(0, 3)).toEqual([1, 2, 1])
    const beats = r.discovery.seen.slice(from).filter((x) => x.path === "/heartbeat")
    expect(beats[1].at - beats[0].at).toBeGreaterThanOrEqual(900) // the wait is taken, not only said
    expect(r.alive()).toBe(true)
  }, 20_000)
  test("an answered beat waits the rhythm discovery gives (nextHeartbeatMs), not a retry wait (a guard)", async () => {
    const r = await records()
    await until(() => r.after("/heartbeat", 1), "a first heartbeat")
    const from = r.count("/heartbeat")
    await Bun.sleep(1000)
    expect(r.count("/heartbeat") - from).toBeGreaterThanOrEqual(5) // 100 ms apart, as discovery answers
  }, 20_000)
})

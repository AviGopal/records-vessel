// SPDX-License-Identifier: MIT
// Identity giving no answer is identity's outage, not the caller's refusal, and never ends records (src/auth.ts ask,
// src/serve-error.ts): on the running vessel, with identity a listener that closes every connection on its first bytes
// (a reset on the way, as across a relay), a key's call and an on-behalf-of call are each answered 503, and records goes
// on serving. A request that throws anyway (here: identity answering 200 with no data, read as if it had some) is
// answered 500 and the process is never ended.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"
import { onServeError } from "../src/serve-error"

const NODE_KEY = "node-key-for-no-answer-test"
const TRANSPORT = "federation-transport-vessel@no-answer-test"
const SELF = "12D3KooWSelfNoAnswerPlaceholder"

let discovery: Fake
let reset: ReturnType<typeof Bun.listen>
// how identity answers each connection: closed on its first bytes, a 200 whose body breaks off, or a 200 with no data
let mode: "reset" | "cut" | "no-data" = "reset"
const NO_DATA = '{"success":true}'

let dir: string
let port: number
let vessel: ReturnType<typeof run>

const call = async (auth: string, pointer: object) => {
  const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ impulse: { pointer } }),
  })
  return r.status
}

beforeAll(async () => {
  discovery = fake((path, body) => {
    if (path === "/heartbeat") return Response.json({ nextHeartbeatMs: 600000 })
    if (path === "/resolve" && body?.pointer?.type === "vesselRegistry") {
      return Response.json({ content: { vessels: [{ vesselId: TRANSPORT, libp2p_peer_id: SELF, protocol: "libp2p" }] } })
    }
    return Response.json({ ok: true })
  })
  reset = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data: (s) => {
      if (mode === "cut") s.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"succ`)
      if (mode === "no-data") s.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${NO_DATA.length}\r\nConnection: close\r\n\r\n${NO_DATA}`)
      s.end()
    },
  } })
  dir = mkdtempSync(join(tmpdir(), "records-no-answer-"))
  port = freePort()
  vessel = run("src/index.ts", {
    RECORDS_VESSEL_ID: "records-no-answer-test",
    RECORDS_PORT: String(port),
    DISCOVERY_URL: discovery.url,
    RECORDS_ENDPOINT: `http://127.0.0.1:${port}`,
    RECORDS_DATA_DIR: dir,
    IDENTITY_VESSEL_URL: `http://127.0.0.1:${reset.port}`,
    METABOB_API_KEY: NODE_KEY,
    FED_VESSEL_ID: TRANSPORT,
  })
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
})

afterAll(() => {
  vessel?.kill()
  discovery?.stop()
  reset?.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe("records: identity giving no answer", () => {
  test("[MUST-FAIL] a key's read and write, with identity resetting the connection, are each answered 503, and records still serves", async () => {
    expect(await call("ApiKey some-peer-key", { type: "record_read", shape: "note" })).toBe(503)
    expect(await call("ApiKey some-peer-key", { type: "record_write", row: { shape: "note" }, writer: "x", role: "walk" })).toBe(503)
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    // the node's own key asks identity nothing, and is served as before
    expect(await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(vessel.exitCode).toBeNull()
  })

  test("[MUST-FAIL] a key's read, with identity's answer breaking off in its body, is answered 503, and records still serves", async () => {
    mode = "cut"
    try {
      expect(await call("ApiKey cut-peer-key", { type: "record_read", shape: "note" })).toBe(503)
    } finally {
      mode = "reset"
    }
    expect(await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(vessel.exitCode).toBeNull()
  })

  test("[MUST-FAIL] an on-behalf-of read, with identity resetting the connection, is answered 503, and records still serves", async () => {
    expect(await call("Bearer some-forwarded-token", { type: "record_read", shape: "note" })).toBe(503)
    expect(await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(vessel.exitCode).toBeNull()
  })

  test("[MUST-FAIL] a request that throws (identity's 200 with no data) is answered 500, and records still serves", async () => {
    mode = "no-data"
    try {
      expect(await call("ApiKey another-peer-key", { type: "record_read", shape: "note" })).toBe(500)
    } finally {
      mode = "reset"
    }
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    expect(await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(vessel.exitCode).toBeNull()
  })

  test("the error answer: 500 with the stack logged, and process.exit never called", () => {
    const exit = process.exit
    const logged: string[] = []
    const error = console.error
    let ended = false
    process.exit = (() => { ended = true }) as typeof process.exit
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")) }
    try {
      const r = onServeError(new Error("connection reset on the way"))
      expect(r.status).toBe(500)
      expect(ended).toBe(false)
      expect(logged.some((l) => l.includes("connection reset on the way") && l.includes("no-answer.test.ts"))).toBe(true)
    } finally {
      process.exit = exit
      console.error = error
    }
  })
})

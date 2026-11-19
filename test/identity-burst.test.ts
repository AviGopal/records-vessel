// SPDX-License-Identifier: MIT
// A burst of calls carrying one credential asks identity once (src/identity-ask.ts through src/auth.ts), on the running
// vessel: an unknown key's refusal is kept a moment (a write still asks afresh), a 429 is shared only by the calls in flight (each answered 503, ask again later),
// a burst of writes asks once, and an on-behalf-of token's yes is kept for its shape only, within the expiry identity states.
// identity answers slowly here, so concurrent calls overlap.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-burst-test"
const TRANSPORT = "federation-transport-vessel@burst-test"
const SELF = "12D3KooWSelfBurstPlaceholder"
const ORG = "orgs:fixture-one"
const SLOW_MS = 150

// tokens identity minted: peer keys from this org, with or without a stated expiry
const tokens = new Map<string, { expires?: string }>()
let throttled = false

let discovery: Fake
let identity: Fake
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
const asks = (what: (p: any) => boolean) => identity.seen.filter((s) => what((s.body as any)?.impulse?.pointer ?? {})).length

beforeAll(async () => {
  discovery = fake((path, body) => {
    if (path === "/heartbeat") return Response.json({ nextHeartbeatMs: 600000 })
    if (path === "/resolve" && body?.pointer?.type === "vesselRegistry") {
      return Response.json({ content: { vessels: [{ vesselId: TRANSPORT, libp2p_peer_id: SELF, protocol: "libp2p" }] } })
    }
    return Response.json({ ok: true })
  })
  identity = fake(async (_path, body) => {
    await Bun.sleep(SLOW_MS)
    const p = body?.impulse?.pointer ?? {}
    if (p.type === "apiKey") {
      if (p.apiKey === NODE_KEY) return Response.json({ success: true, data: { authenticated: true, keyId: "kid-node", orgId: ORG } })
      if (throttled) return Response.json({ error: "rate limited" }, { status: 429 })
      // identity also says no in a 200 body: it answered, and did not authenticate
      if (String(p.apiKey).startsWith("body-")) return Response.json({ success: true, data: { authenticated: false, reason: "unknown key" } })
      // identity forbids a key it knows but will not admit: a refusal, kept as a 401 is
      if (String(p.apiKey).startsWith("forbidden-")) return Response.json({ success: false }, { status: 403 })
      return Response.json({ success: false }, { status: 401 })
    }
    const t = tokens.get(String(p.token ?? ""))
    if (p.type !== "session" || t === undefined || p.audience?.node !== SELF) return Response.json({ success: false }, { status: 401 })
    const obo = { node: SELF, shape: p.audience.shape, ...(t.expires === undefined ? {} : { expires_at: t.expires }) }
    return Response.json({ success: true, data: { authenticated: true, keyId: "kid-node-two", orgId: ORG, ownerKind: "peer", obo } })
  })
  dir = mkdtempSync(join(tmpdir(), "records-burst-"))
  port = freePort()
  vessel = run("src/index.ts", {
    RECORDS_VESSEL_ID: "records-burst-test",
    RECORDS_PORT: String(port),
    DISCOVERY_URL: discovery.url,
    RECORDS_ENDPOINT: `http://127.0.0.1:${port}`,
    RECORDS_DATA_DIR: dir,
    IDENTITY_VESSEL_URL: identity.url,
    METABOB_API_KEY: NODE_KEY,
    FED_VESSEL_ID: TRANSPORT,
  })
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
})

afterAll(() => {
  vessel?.kill()
  discovery?.stop()
  identity?.stop()
  rmSync(dir, { recursive: true, force: true })
})

const burst = (n: number, f: () => Promise<number>) => Promise.all(Array.from({ length: n }, f))

describe("records: a burst of calls with one credential asks identity once", () => {
  test("[MUST-FAIL] an unknown key's burst of reads: one ask, every call refused; a read just after is refused without asking", async () => {
    const key = "ApiKey unknown-key-one"
    const statuses = await burst(20, () => call(key, { type: "record_read", shape: "note" }))
    expect(new Set(statuses)).toEqual(new Set([401]))
    expect(await call(key, { type: "record_read", shape: "note" })).toBe(401)
    expect(asks((p) => p.apiKey === "unknown-key-one")).toBe(1)
    // a write reads nothing kept: identity is asked afresh (a key identity marks counts from its next write)
    expect(await call(key, { type: "record_write", row: { shape: "note" }, writer: "x", role: "walk" })).toBe(401)
    expect(asks((p) => p.apiKey === "unknown-key-one")).toBe(2)
    // a no said in a 200 body is a no too, kept the same way
    const body = "ApiKey body-unknown-key"
    expect(new Set(await burst(10, () => call(body, { type: "record_read", shape: "note" })))).toEqual(new Set([401]))
    expect(await call(body, { type: "record_read", shape: "note" })).toBe(401)
    expect(asks((p) => p.apiKey === "body-unknown-key")).toBe(1)
  })
  test("[MUST-FAIL] a 429 is shared by the calls in flight, and the next call asks again; each is told to ask again later (503), never refused", async () => {
    throttled = true
    try {
      const key = "ApiKey unknown-key-two"
      const statuses = await burst(10, () => call(key, { type: "record_read", shape: "note" }))
      expect(new Set(statuses)).toEqual(new Set([503]))
      expect(asks((p) => p.apiKey === "unknown-key-two")).toBe(1)
      expect(await call(key, { type: "record_read", shape: "note" })).toBe(503)
      expect(asks((p) => p.apiKey === "unknown-key-two")).toBe(2)
    } finally {
      throttled = false
    }
  })
  test("[MUST-FAIL] a 403 is kept as a 401 is: a read just after it is refused without asking", async () => {
    const key = "ApiKey forbidden-key"
    expect(await call(key, { type: "record_read", shape: "note" })).toBe(401)
    expect(await call(key, { type: "record_read", shape: "note" })).toBe(401)
    expect(asks((p) => p.apiKey === "forbidden-key")).toBe(1)
  })
  test("a token's yes is never kept past the expiry identity states, however short (a guard)", async () => {
    const short = "obo-burst-short"
    tokens.set(short, { expires: new Date(Date.now() + 2_000).toISOString() })
    expect(await call(`Bearer ${short}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(await call(`Bearer ${short}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(asks((p) => p.token === short)).toBe(1)     // within its expiry: kept
    await Bun.sleep(2_500)
    await call(`Bearer ${short}`, { type: "record_read", shape: "note" })
    expect(asks((p) => p.token === short)).toBe(2)     // past it: asked again, well inside the 30 s a yes may live
  }, 10_000)
  test("[MUST-FAIL] a burst of writes under one token asks once; a write after it asks afresh", async () => {
    const t = "obo-burst-writes"
    tokens.set(t, { expires: new Date(Date.now() + 60_000).toISOString() })
    const write = () => call(`Bearer ${t}`, { type: "record_write", row: { shape: "selection", mark: "burst" }, writer: "walk-vessel", role: "walk" })
    const statuses = await burst(5, write)
    expect(new Set(statuses)).toEqual(new Set([200]))
    expect(asks((p) => p.token === t)).toBe(1)
    expect(await write()).toBe(200)
    expect(asks((p) => p.token === t)).toBe(2)
  })
  test("[MUST-FAIL] a token's yes is kept for reads within the expiry identity states; a yes for one shape answers no other; one with no stated expiry is asked every time", async () => {
    const kept = "obo-burst-kept"
    tokens.set(kept, { expires: new Date(Date.now() + 60_000).toISOString() })
    for (let i = 0; i < 3; i++) expect(await call(`Bearer ${kept}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(asks((p) => p.token === kept)).toBe(1)
    // a yes for one shape answers no other: the same token for another shape is asked for that shape
    expect(await call(`Bearer ${kept}`, { type: "record_summary", shape: "note" })).not.toBe(401)
    expect(identity.seen.filter((s) => (s.body as any)?.impulse?.pointer?.token === kept).map((s) => (s.body as any).impulse.pointer.audience.shape))
      .toEqual(["record_read", "record_summary"])
    const bare = "obo-burst-bare"
    tokens.set(bare, {})
    for (let i = 0; i < 3; i++) expect(await call(`Bearer ${bare}`, { type: "record_read", shape: "note" })).toBe(200)
    expect(asks((p) => p.token === bare)).toBe(3)
  })
})

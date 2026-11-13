// SPDX-License-Identifier: MIT
// A federation on-behalf-of token, forwarded by this node's transport as `Authorization: Bearer <token>`. records accepts it
// only when identity answers the binding for exactly this node (its transport's peer id, from that transport's own row in
// local discovery) and the shape being served, and with a caller key. A read is served; a write is refused until
// identity marks whose key it is, whatever writer and role the body declares.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const TRANSPORT = "federation-transport-vessel@obo-test"
const SELF = "12D3KooWSelfPlaceholderPeer"
const OTHER = "12D3KooWOtherPlaceholderPeer"

// identity's state: each token it minted, with its audience, caller key id and whether it has expired.
// lies: identity answers this binding whatever audience was asked (records must check the answer itself).
const tokens = new Map<string, { node: string; shape: string; keyId: string; expired?: boolean; session?: boolean; lies?: { node: string; shape: string } }>()
let n = 0
const token = (node: string, shape: string, extra: { expired?: boolean; session?: boolean; keyId?: string; lies?: { node: string; shape: string } } = {}): string => {
  const t = `obo-placeholder-${++n}`
  tokens.set(t, { node, shape, keyId: extra.keyId ?? "kid-caller", ...extra })
  return t
}

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
  return { status: r.status, body: (await r.json()) as any }
}

beforeAll(async () => {
  // Local discovery: this node's transport row, and another node's transport mirrored here (the hub holds such rows).
  discovery = fake((path, body) => {
    if (path === "/heartbeat") return Response.json({ nextHeartbeatMs: 600000 })
    if (path === "/resolve" && body?.pointer?.type === "vesselRegistry") {
      return Response.json({ content: { vessels: [
        { vesselId: `federation-transport-vessel@elsewhere`, libp2p_peer_id: OTHER, protocol: "libp2p" },
        { vesselId: TRANSPORT, libp2p_peer_id: SELF, protocol: "libp2p" },
      ] } })
    }
    return Response.json({ ok: true })
  })
  // identity: answers a token only for the audience it was minted for, as resolveAuthentication does; a session token is
  // authenticated with no on-behalf-of binding; an expired one is refused.
  identity = fake((_path, body) => {
    const p = body?.impulse?.pointer ?? {}
    const t = tokens.get(String(p.token ?? ""))
    if (p.type !== "session" || t === undefined || t.expired) return Response.json({ success: false }, { status: 401 })
    if (t.session) return Response.json({ success: true, data: { authenticated: true, keyId: t.keyId } })
    if (t.lies) return Response.json({ success: true, data: { authenticated: true, keyId: t.keyId, obo: t.lies } })
    if (p.audience?.node !== t.node || p.audience?.shape !== t.shape) return Response.json({ success: false }, { status: 401 })
    return Response.json({ success: true, data: { authenticated: true, keyId: t.keyId, obo: { node: t.node, shape: t.shape } } })
  })
  dir = mkdtempSync(join(tmpdir(), "records-obo-"))
  port = freePort()
  vessel = run("src/index.ts", {
    RECORDS_VESSEL_ID: "records-obo-test",
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
  const w = await call(`ApiKey ${NODE_KEY}`, { type: "record_write", row: { shape: "note", text: "seed" }, writer: "walk-test", role: "walk" })
  expect(w.status).toBe(200)
})

afterAll(() => {
  vessel?.kill()
  discovery?.stop()
  identity?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe("records: a federation on-behalf-of token", () => {
  test("a token for this node's transport and this shape reads, and identity is asked for exactly that audience", async () => {
    const t = token(SELF, "record_read")
    const r = await call(`Bearer ${t}`, { type: "record_read", shape: "note" })
    expect(r.status).toBe(200)
    expect(r.body.map((x: any) => x.text)).toEqual(["seed"])
    const asked = identity.seen.filter((s) => (s.body as any)?.impulse?.pointer?.token === t).map((s) => (s.body as any).impulse.pointer.audience)
    expect(asked).toEqual([{ node: SELF, shape: "record_read" }])
  })

  test("[MUST-FAIL] a write is refused under any declared writer and role, and nothing is written", async () => {
    const before = (await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "outcome" })).body.length
    for (const as of [{}, { writer: "kid-x", role: "person" }, { writer: "walk-test", role: "owner" }, { writer: "walk-test", role: "walk" }]) {
      const r = await call(`Bearer ${token(SELF, "record_write")}`, { type: "record_write", row: { shape: "outcome", r: 1 }, ...as })
      expect([as, r.status, r.body?.failure?.body]).toEqual([as, 403, "cross-node writes wait for person marking"])
    }
    expect((await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "outcome" })).body.length).toBe(before)
  })

  test("[MUST-FAIL] a token minted for another node, or for another shape, is refused", async () => {
    expect((await call(`Bearer ${token(OTHER, "record_read")}`, { type: "record_read", shape: "note" })).status).toBe(401)
    expect((await call(`Bearer ${token(SELF, "record_write")}`, { type: "record_read", shape: "note" })).status).toBe(401)
  })

  test("[MUST-FAIL] records checks identity's answer itself: a binding for another shape or another node is refused", async () => {
    for (const lies of [{ node: SELF, shape: "record_write" }, { node: OTHER, shape: "record_read" }]) {
      const r = await call(`Bearer ${token(SELF, "record_read", { lies })}`, { type: "record_read", shape: "note" })
      expect([lies, r.status]).toEqual([lies, 401])
    }
  })

  test("[MUST-FAIL] a session token identity accepts, with no on-behalf-of binding, is refused", async () => {
    expect((await call(`Bearer ${token(SELF, "record_read", { session: true })}`, { type: "record_read", shape: "note" })).status).toBe(401)
  })

  test("[MUST-FAIL] an expired token, and one with no caller key, are refused", async () => {
    expect((await call(`Bearer ${token(SELF, "record_read", { expired: true })}`, { type: "record_read", shape: "note" })).status).toBe(401)
    expect((await call(`Bearer ${token(SELF, "record_read", { keyId: "" })}`, { type: "record_read", shape: "note" })).status).toBe(401)
  })

  test("[MUST-FAIL] the node's own key in a Bearer header is not the node: it is a token identity does not know", async () => {
    const r = await call(`Bearer ${NODE_KEY}`, { type: "record_write", row: { shape: "note", text: "x" }, writer: "walk-test", role: "walk" })
    expect(r.status).toBe(401)
  })
})

describe("records with no federation transport named", () => {
  let other: ReturnType<typeof run>
  let p2: number
  let d2: string
  beforeAll(async () => {
    d2 = mkdtempSync(join(tmpdir(), "records-obo-none-"))
    p2 = freePort()
    other = run("src/index.ts", {
      RECORDS_VESSEL_ID: "records-obo-none", RECORDS_PORT: String(p2), DISCOVERY_URL: discovery.url,
      RECORDS_ENDPOINT: `http://127.0.0.1:${p2}`, RECORDS_DATA_DIR: d2, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
    })
    await healthy(p2)
  })
  afterAll(() => { other?.kill(); rmSync(d2, { recursive: true, force: true }) })
  test("[MUST-FAIL] every token is refused, for any transport local discovery lists: there is no node it was minted for", async () => {
    for (const node of [SELF, OTHER]) {
      const t = token(node, "record_read")
      const r = await fetch(`http://127.0.0.1:${p2}/v2/impulses/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ impulse: { pointer: { type: "record_read", shape: "note" } } }),
      })
      expect([node, r.status]).toEqual([node, 401])
      // Refused before identity is asked: there is no node to state as the audience.
      expect([node, identity.seen.filter((x) => (x.body as any)?.impulse?.pointer?.token === t).length]).toEqual([node, 0])
    }
  })
})

describe("records: a token's life", () => {
  test("[MUST-FAIL] a token that was good is refused once identity says it has expired: no answer is reused", async () => {
    const t = token(SELF, "record_read")
    expect((await call(`Bearer ${t}`, { type: "record_read", shape: "note" })).status).toBe(200)
    tokens.get(t)!.expired = true
    expect((await call(`Bearer ${t}`, { type: "record_read", shape: "note" })).status).toBe(401)
  })
})

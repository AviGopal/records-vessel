// SPDX-License-Identifier: MIT
// A federation on-behalf-of token, forwarded by this node's transport as `Authorization: Bearer <token>`. records accepts it
// only when identity answers the binding for exactly this node (its transport's peer id, from that transport's own row in
// local discovery) and the shape being served, and with a caller key. A read is served. A write is taken exactly as the
// caller key's write would be on its own node, and only from this records' org: another node's key (peer) writes that
// node's rows as declared, never a person's, an operator's or the owner's; a person's key writes a person's row; any
// other key's write is refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const TRANSPORT = "federation-transport-vessel@obo-test"
const SELF = "12D3KooWSelfPlaceholderPeer"
const OTHER = "12D3KooWOtherPlaceholderPeer"
const ORG = "orgs:fixture-one"
const ELSEWHERE = "orgs:fixture-two"

// identity's state: each token it minted, with its audience, caller key id and whether it has expired.
// lies: identity answers this binding whatever audience was asked (records must check the answer itself).
// org: the org identity signed into the token from the caller's key (null: none); kind: the caller key's class.
type Extra = { expired?: boolean; session?: boolean; keyId?: string; lies?: { node: string; shape: string }; org?: string | null; kind?: string }
const tokens = new Map<string, { node: string; shape: string; keyId: string } & Extra>()
let n = 0
const token = (node: string, shape: string, extra: Extra = {}): string => {
  const t = `obo-placeholder-${++n}`
  tokens.set(t, { node, shape, keyId: extra.keyId ?? "kid-caller", ...extra })
  return t
}

let discovery: Fake
let identity: Fake
let dir: string
let port: number
let vessel: ReturnType<typeof run>
// What records printed, kept as it runs, so a test can read the lines a refusal writes.
let printed = ""

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
    // The node's own key, as identity answers it: in this records' org.
    if (p.type === "apiKey") {
      return p.apiKey === NODE_KEY ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-node", orgId: ORG } }) : Response.json({ success: false }, { status: 401 })
    }
    const t = tokens.get(String(p.token ?? ""))
    if (p.type !== "session" || t === undefined || t.expired) return Response.json({ success: false }, { status: 401 })
    if (t.session) return Response.json({ success: true, data: { authenticated: true, keyId: t.keyId } })
    if (t.lies) return Response.json({ success: true, data: { authenticated: true, keyId: t.keyId, obo: t.lies } })
    if (p.audience?.node !== t.node || p.audience?.shape !== t.shape) return Response.json({ success: false }, { status: 401 })
    const org = t.org === null ? {} : { orgId: t.org ?? ORG }
    const kind = t.kind === undefined ? {} : { ownerKind: t.kind }
    return Response.json({ success: true, data: { authenticated: true, keyId: t.keyId, ...org, ...kind, obo: { node: t.node, shape: t.shape } } })
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
  void (async () => { const d = new TextDecoder(); for await (const c of vessel.stdout as any) printed += d.decode(c, { stream: true }) })()
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

  const count = async (shape: string): Promise<number> => (await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape })).body.length
  const write = (extra: Extra, body: object) => call(`Bearer ${token(SELF, "record_write", extra)}`, { type: "record_write", ...body })

  test("another node's key in this org writes that node's rows as declared: walk, described and gap", async () => {
    // A described row cites the walk's selection it answers (records refuses one that cites none), as on its own node.
    const sel = await write({ kind: "peer", keyId: "kid-node-two" }, { row: { shape: "selection", mark: "far-selection" }, writer: "walk-vessel", role: "walk" })
    expect(sel.status).toBe(200)
    const selId = (await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "selection" })).body.find((x: any) => x.mark === "far-selection").id
    for (const [shape, writer, role] of [["hop", "walk-vessel", "walk"], ["land_verdict", "described-shape-vessel", "described"], ["gap", "pull-sync", "detector"]]) {
      const r = await write({ kind: "peer", keyId: "kid-node-two" }, { row: { shape, mark: `far-${shape}`, selection_ref: selId }, writer, role })
      expect([shape, r.status]).toEqual([shape, 200])
      const back = (await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape })).body.filter((x: any) => x.mark === `far-${shape}`)
      expect(back.map((x: any) => [x.writer, x.role])).toEqual([[writer, role]])
    }
  })

  test("[MUST-FAIL] another node's key writes no person's, operator's or owner row, and nothing is written", async () => {
    const before = await count("outcome")
    for (const role of ["person", "operator", "owner"]) {
      const r = await write({ kind: "peer" }, { row: { shape: "outcome", r: 1 }, writer: "walk-vessel", role })
      expect([role, r.status, r.body?.failure?.body]).toEqual([role, 403, "another node writes its own rows, never a person's, an operator's or this node's owner rows"])
    }
    expect(await count("outcome")).toBe(before)
  })

  test("[MUST-FAIL] a key in another org, or a token with no org, writes nothing, whatever its class", async () => {
    const before = await count("hop")
    for (const kind of ["peer", "person"]) {
      const r = await write({ kind, org: ELSEWHERE }, { row: { shape: "hop" }, writer: "walk-vessel", role: "walk" })
      expect([kind, r.status, r.body?.failure?.body]).toEqual([kind, 403, "a cross-node write is taken only from this records' org"])
    }
    const none = await write({ kind: "peer", org: null }, { row: { shape: "hop" }, writer: "walk-vessel", role: "walk" })
    expect(none.status).toBe(403)
    expect(none.body?.failure?.body).toContain("the caller's: not answered")
    expect(await count("hop")).toBe(before)
  })

  test("[MUST-FAIL] an operator's key, and a key identity marks as neither a person's nor a node's, write nothing across nodes", async () => {
    const before = await count("hop")
    for (const kind of ["operator", "system", "unclassified", undefined]) {
      const r = await write({ kind }, { row: { shape: "hop" }, writer: "walk-vessel", role: "walk" })
      expect([kind, r.status, r.body?.failure?.body]).toEqual([kind, 403, "a cross-node write needs a key identity marks as a person's or another node's"])
    }
    expect(await count("hop")).toBe(before)
  })

  test("a person's key from another node of this org writes a person's row under its own key, whatever it declares", async () => {
    const r = await write({ kind: "person", keyId: "kid-person" }, { row: { shape: "world_changed", what: "far-ask" }, writer: "walk-vessel", role: "walk" })
    expect(r.status).toBe(200)
    const back = (await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "world_changed" })).body.filter((x: any) => x.what === "far-ask")
    expect(back.map((x: any) => [x.writer, x.role])).toEqual([["kid-person", "person"]])
  })

  test("[MUST-FAIL] a person's key writes no gap across nodes, as on its own node", async () => {
    const before = await count("gap")
    const r = await write({ kind: "person" }, { row: { shape: "gap", gap_id: "far" } })
    expect([r.status, r.body?.failure?.body]).toEqual([403, "a gap row is written only under the node's own key"])
    expect(await count("gap")).toBe(before)
  })

  test("[MUST-FAIL] another node's key must declare a writer and a role", async () => {
    expect((await write({ kind: "peer" }, { row: { shape: "hop" } })).status).toBe(400)
  })

  test("[MUST-FAIL] a refused cross-node write is said in records' output, with the reason and the shape, never the token", async () => {
    const t = token(SELF, "record_write", { kind: "unclassified" })
    const r = await call(`Bearer ${t}`, { type: "record_write", row: { shape: "note_from_far", text: "x" }, writer: "w", role: "walk" })
    expect(r.status).toBe(403)
    await until(() => printed.includes("(shape=note_from_far)"), "the refusal line")
    expect(printed).toContain("[records] refused a cross-node write: a cross-node write needs a key identity marks as a person's or another node's (shape=note_from_far)")
    expect(printed).not.toContain(t)
    expect(printed).not.toContain(ORG)
  })

  test("[MUST-FAIL] a remote row's shape cannot forge a journal line or run past 64 characters in the refusal line", async () => {
    const long = "y".repeat(80)
    for (const shape of ["x\n[records] forged", long]) {
      const r = await call(`Bearer ${token(SELF, "record_write")}`, { type: "record_write", row: { shape, text: "x" } })
      expect(r.status).toBe(403)
    }
    await until(() => printed.split("\n").filter((l) => l.startsWith("[records] refused a cross-node write")).length >= 3, "both refusal lines")
    expect(printed.split("\n").some((l) => l.startsWith("[records] forged"))).toBe(false)
    for (const l of printed.split("\n").filter((x) => x.startsWith("[records] refused a cross-node write"))) {
      const shape = /\(shape=(.*)\)$/.exec(l)?.[1] ?? ""
      expect(shape.length).toBeLessThanOrEqual(64)
    }
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

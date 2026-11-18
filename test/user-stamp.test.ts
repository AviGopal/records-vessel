// SPDX-License-Identifier: MIT
// Whose row, by user: a person's row carries the user identity names for its key (user_id), stamped by records at the
// write as writer is, on a person's row only, and nothing when identity names none (never the keyId). A user_id a sender
// put in its row is never stored as given. ask_state serves it as asker_user, null when the ask has none, and where
// {asker_user} narrows to one user's asks across their keys. Through a real records process, on its own key path and on
// a federation on-behalf-of token, with identity answering as resolveAPIKey and a session binding do.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const TRANSPORT = "federation-transport-vessel@stamp-test"
const SELF = "12D3KooWSelfPlaceholderPeer"
const ORG = "orgs:fixture-one"
// keys: a person's two keys of one user (an older and a newer), a person's key with no user, an operator's key with a user
const KEYS: Record<string, { keyId: string; ownerKind: string; userId?: string }> = {
  "person-old-key": { keyId: "kid-old", ownerKind: "person", userId: "user:fixture-a" },
  "person-new-key": { keyId: "kid-new", ownerKind: "person", userId: "user:fixture-a" },
  "person-other-key": { keyId: "kid-other", ownerKind: "person", userId: "user:fixture-b" },
  "person-nouser-key": { keyId: "kid-nouser", ownerKind: "person" },
  "person-emptyuser-key": { keyId: "kid-emptyuser", ownerKind: "person", userId: "" },
  "person-numuser-key": { keyId: "kid-numuser", ownerKind: "person", userId: 7 as unknown as string },
  "operator-key": { keyId: "kid-operator", ownerKind: "operator", userId: "user:fixture-a" },
}
// on-behalf-of tokens identity minted: the caller's key, its class, its user
const TOKENS: Record<string, { keyId: string; kind: string; userId?: string }> = {
  "obo-person": { keyId: "kid-far-person", kind: "person", userId: "user:fixture-a" },
  "obo-peer": { keyId: "kid-node-two", kind: "peer", userId: "user:fixture-a" },
}

let stop: () => void = () => {}
afterEach(() => stop())

type R = Record<string, any>
// pre: rows already in the store when records starts (rows written before this change, as stored then)
const fresh = async (pre: R[] = []) => {
  const discovery: Fake = fake((path, body) => {
    if (path === "/heartbeat") return Response.json({ nextHeartbeatMs: 600000 })
    if (path === "/resolve" && body?.pointer?.type === "vesselRegistry") {
      return Response.json({ content: { vessels: [{ vesselId: TRANSPORT, libp2p_peer_id: SELF, protocol: "libp2p" }] } })
    }
    return Response.json({ ok: true })
  })
  const identity: Fake = fake((_p, body) => {
    const p = body?.impulse?.pointer ?? {}
    if (p.type === "apiKey") {
      if (p.apiKey === NODE_KEY) return Response.json({ success: true, data: { authenticated: true, keyId: "kid-node", orgId: ORG } })
      const k = KEYS[String(p.apiKey)]
      return k ? Response.json({ success: true, data: { authenticated: true, orgId: ORG, ...k } }) : Response.json({ success: false }, { status: 401 })
    }
    const t = TOKENS[String(p.token ?? "")]
    if (p.type !== "session" || t === undefined || p.audience?.node !== SELF) return Response.json({ success: false }, { status: 401 })
    return Response.json({ success: true, data: { authenticated: true, keyId: t.keyId, orgId: ORG, ownerKind: t.kind,
      ...(t.userId ? { userId: t.userId } : {}), obo: { node: SELF, shape: p.audience.shape } } })
  })
  const dir = mkdtempSync(join(tmpdir(), "records-stamp-"))
  if (pre.length > 0) writeFileSync(join(dir, "rows"), pre.map((r) => `${JSON.stringify(r)}\n`).join(""))
  const port = freePort()
  const vessel = run("src/index.ts", {
    RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: String(port), DISCOVERY_URL: discovery.url,
    RECORDS_ENDPOINT: `http://127.0.0.1:${port}`, RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
    FED_VESSEL_ID: TRANSPORT,
  })
  stop = () => { vessel.kill(); discovery.stop(); identity.stop(); rmSync(dir, { recursive: true, force: true }) }
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
  const call = async (auth: string, pointer: object) => {
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify({ impulse: { pointer } }),
    })
    return (await r.json()) as any
  }
  const write = (key: string, row: object, as?: { writer: string; role: string }) => call(`ApiKey ${key}`, { type: "record_write", row, ...(as ?? {}) }) as Promise<R>
  const obo = (token: string, row: object, as?: { writer: string; role: string }) => call(`Bearer ${token}`, { type: "record_write", row, ...(as ?? {}) }) as Promise<R>
  const byId = async (id: string) => ((await call(`ApiKey ${NODE_KEY}`, { type: "record_read", ids: [id] })) as R[])[0]!
  const states = async (where?: object) => (await call(`ApiKey ${NODE_KEY}`, { type: "record_read", shape: "ask_state", ...(where ? { where } : {}) })) as R[]
  await write(NODE_KEY, { shape: "shape_schema", target: "request", inputs: [{ shape: "world_changed", ask: true }] }, { writer: "owner", role: "owner" })
  return { call, write, obo, byId, states }
}

describe("a person's row carries the user identity names for its key", () => {
  test("[MUST-FAIL] a person's write is stamped with the key's user, records' own field, and the keyId stays the writer", async () => {
    const s = await fresh()
    const a = await s.write("person-old-key", { shape: "world_changed", what: "q" })
    const got = await s.byId(a.id)
    expect([got.user_id, got.writer, got.role]).toEqual(["user:fixture-a", "kid-old", "person"])
    expect(a.user_id).toBe("user:fixture-a")
  })

  test("[MUST-FAIL] a person's key from another node, on an on-behalf-of token, is stamped the same way", async () => {
    const s = await fresh()
    const a = await s.obo("obo-person", { shape: "world_changed", what: "far" })
    const got = await s.byId(a.id)
    expect([got.user_id, got.writer, got.role]).toEqual(["user:fixture-a", "kid-far-person", "person"])
  })

  test("[MUST-FAIL] identity naming no user stamps nothing, never the keyId; a user_id the sender put there is not stored", async () => {
    const s = await fresh()
    for (const key of ["person-nouser-key", "person-emptyuser-key", "person-numuser-key"]) {
      // no user, an empty one, or one that is not a string: identity named none
      const a = await s.write(key, { shape: "world_changed", what: "q", user_id: "user:forged" })
      const got = await s.byId(a.id)
      expect([key, "user_id" in got]).toEqual([key, false])
    }
  })

  test("[MUST-FAIL] a forged user_id is overwritten by the key's own user on a person's row", async () => {
    const s = await fresh()
    const a = await s.write("person-other-key", { shape: "world_changed", what: "q", user_id: "user:fixture-a" })
    expect((await s.byId(a.id)).user_id).toBe("user:fixture-b")
  })

  test("[MUST-FAIL] an operator's, another node's or the node's own write gets no stamp, and a user_id it sent is not stored", async () => {
    const s = await fresh()
    const op = await s.write("operator-key", { shape: "world_changed", what: "op", user_id: "user:forged" })
    const peer = await s.obo("obo-peer", { shape: "hop", mark: "far", user_id: "user:forged" }, { writer: "walk-vessel", role: "walk" })
    const own = await s.write(NODE_KEY, { shape: "note", text: "n", user_id: "user:forged" }, { writer: "walk-test", role: "walk" })
    for (const id of [op.id, peer.id, own.id]) expect("user_id" in (await s.byId(id))).toBe(false)
  })

  test("[MUST-FAIL] ask_state serves asker_user: the ask's stamped user, null when it has none or is not a person's", async () => {
    const s = await fresh()
    const a = await s.write("person-old-key", { shape: "world_changed", what: "a" })
    const b = await s.write("person-nouser-key", { shape: "world_changed", what: "b" })
    const c = await s.write("operator-key", { shape: "world_changed", what: "c" })
    const got = await s.states()
    expect(got.map((r) => [r.root, r.asker, r.asker_user])).toEqual([[a.id, "kid-old", "user:fixture-a"], [b.id, "kid-nouser", null], [c.id, "kid-operator", null]])
  })

  test("[MUST-FAIL] a stored user_id on an ask that is not a person's (a row written before records owned the field) is no asker_user", async () => {
    const t = "2026-11-01T00:00:00.000Z"
    const old = { shape: "world_changed", what: "old", user_id: "user:fixture-a", input_refs: [], seq: 1, t, writer: "kid-operator", role: "operator", id: "old-operator-ask" }
    const s = await fresh([old])
    expect((await s.states()).map((r) => [r.root, r.asker_role, r.asker_user])).toEqual([["old-operator-ask", "operator", null]])
  })

  test("[MUST-FAIL] where {asker_user} answers one user's asks across their keys, and none of another user's or of no user", async () => {
    const s = await fresh()
    const a = await s.write("person-old-key", { shape: "world_changed", what: "old key" })
    const b = await s.write("person-new-key", { shape: "world_changed", what: "new key" })
    const c = await s.write("person-other-key", { shape: "world_changed", what: "other user" })
    await s.write("person-nouser-key", { shape: "world_changed", what: "no user" })
    expect((await s.states({ asker_user: "user:fixture-a" })).map((r) => r.root)).toEqual([a.id, b.id])
    expect((await s.states({ asker_user: "user:fixture-b" })).map((r) => r.root)).toEqual([c.id])
    expect((await s.states({ asker: "kid-new" })).map((r) => r.root)).toEqual([b.id])
  })

  test("[MUST-FAIL] a where naming no user matches nothing: null, the string \"null\" and an empty string, beside unstamped asks", async () => {
    const s = await fresh()
    const a = await s.write("person-old-key", { shape: "world_changed", what: "stamped" })
    await s.write("person-nouser-key", { shape: "world_changed", what: "no user" })
    await s.write("operator-key", { shape: "world_changed", what: "operator" })
    // the asks are there, two of them with asker_user null
    expect((await s.states()).map((r) => r.asker_user)).toEqual(["user:fixture-a", null, null])
    expect(await s.states({ asker_user: null })).toEqual([])
    expect(await s.states({ asker_user: "null" })).toEqual([])
    expect(await s.states({ asker_user: "" })).toEqual([])
    // for every key, not only asker_user
    expect(await s.states({ asker: null })).toEqual([])
    expect(await s.states({ asker: "" })).toEqual([])
    // a named user still narrows to its asks
    expect((await s.states({ asker_user: "user:fixture-a" })).map((r) => r.root)).toEqual([a.id])
    // a number names a number: where {seq} finds its ask
    expect((await s.states({ seq: a.seq })).map((r) => r.root)).toEqual([a.id])
  })

  test("[MUST-FAIL] a where value names one type: seq as a string matches nothing, seq as a number matches its ask", async () => {
    const s = await fresh()
    const a = await s.write("person-old-key", { shape: "world_changed", what: "stamped" })
    expect(typeof a.seq).toBe("number")
    expect(await s.states({ seq: String(a.seq) })).toEqual([])
    expect((await s.states({ seq: a.seq })).map((r) => r.root)).toEqual([a.id])
  })
})

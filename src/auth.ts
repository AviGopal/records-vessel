// SPDX-License-Identifier: MIT
import { timingSafeEqual } from "node:crypto"
import { DISCOVERY_URL, IDENTITY_URL, KEY, TRANSPORT_ID } from "./config"
import { DISCOVERY_RESOLVE, IDENTITY_RESOLVE } from "./routes"
import { AUTHENTICATION } from "./shapes"

// obo: the caller came from another node, with an on-behalf-of token its transport forwarded (who.keyId is the caller's key).
// ownerKind: the key's class as identity marks it (person, operator, ...); records stamps a person's row only for "person".
// orgId: the org identity found for the caller's key (for an on-behalf-of token, the org the minting identity signed into
// it from the caller's key), never a value the sender states.
export type Who = { ok: boolean; self: boolean; keyId: string; obo?: boolean; ownerKind?: string; orgId?: string }
type Answer = { success: boolean; data: { authenticated: boolean; keyId: string; ownerKind?: unknown; orgId?: unknown; obo?: { node: string; shape: string } } }
type Known = { keyId: string; ownerKind?: string; orgId?: string }
const kindOf = (a: Answer): { ownerKind?: string; orgId?: string } => ({
  ...(typeof a.data.ownerKind === "string" ? { ownerKind: a.data.ownerKind } : {}),
  ...(typeof a.data.orgId === "string" && a.data.orgId !== "" ? { orgId: a.data.orgId } : {}),
})

// Each key's answer is kept for reads, so identity is not asked on every read. A write asks identity afresh (fresh): a
// key's class decides whether its row is a person's, so a mark identity gives or takes back counts from the next write,
// not from the next restart.
const known = new Map<string, Known>()

const digest = (key: string): Buffer => new Bun.CryptoHasher("sha256").update(key).digest()

const OWN = digest(KEY)

const header = (req: Request): string => String(req.headers.get("authorization"))

export const keyOf = (req: Request): string => header(req).split(" ").slice(1).join(" ")

const ask = async (pointer: Record<string, unknown>): Promise<Answer | undefined> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { type: AUTHENTICATION, pointer } }),
    timeout: false,
  }
  const r = await fetch(new URL(IDENTITY_RESOLVE, IDENTITY_URL).href, init)
  if (!r.ok) {
    return undefined
  }
  const a = (await r.json()) as Answer
  if (!a.success || !a.data.authenticated) {
    return undefined
  }
  return a
}

const validate = async (key: string, fresh = false): Promise<Known | undefined> => {
  const h = digest(key).toString("hex")
  const hit = known.get(h)
  if (hit !== undefined && !fresh) {
    return hit
  }
  const a = await ask({ type: "apiKey", apiKey: key })
  if (a === undefined) {
    return undefined
  }
  const found: Known = { keyId: String(a.data.keyId), ...kindOf(a) }
  known.set(h, found)
  return found
}

// This records' own org: the org the same identity answers for this node's own key, asked again after a while so a key
// moved to another org is not held to its old one. undefined when identity does not answer it (a cross-node write is
// then refused, never taken on a guess).
const ORG_TTL_MS = 300_000
let own: { at: number; orgId?: string } | undefined
export const ownOrg = async (): Promise<string | undefined> => {
  if (own !== undefined && Date.now() - own.at < ORG_TTL_MS) {
    return own.orgId
  }
  const a = await ask({ type: "apiKey", apiKey: KEY }).catch(() => undefined)
  const orgId = a === undefined ? undefined : kindOf(a).orgId
  // An unanswered ask is not kept: the next write asks again.
  own = orgId === undefined ? undefined : { at: Date.now(), orgId }
  return orgId
}

// This node's federation transport's peer id: the node an on-behalf-of token for this records must have been minted for.
// Read from the transport's own row in local discovery (no peer fan-out), by the transport id this node's bootstrap env
// names. That row is written under the node key, so any holder of the node key could rewrite it: this check is defence in
// depth. The primary one is the transport's ingress, which checked the token against its libp2p node's own peer id before
// forwarding it here.
let peer: { at: number; id: string } | undefined
// Whether this records last found its transport's peer id, logged when that changes (a yes or no, never the id or the
// env value): the one place an operator can see that federation reads are live here, or inert because nothing names
// the transport or its row is missing.
let found: boolean | undefined

const transportPeer = async (): Promise<string> => {
  if (peer !== undefined && Date.now() - peer.at < 60_000) {
    return peer.id
  }
  let id = ""
  if (TRANSPORT_ID !== "") {
    const r = await fetch(new URL(DISCOVERY_RESOLVE, DISCOVERY_URL).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${KEY}`, "X-Discovery-Depth": "99" },
      body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
    }).catch(() => undefined)
    const j = r?.ok ? ((await r.json().catch(() => undefined)) as { content?: { vessels?: Array<Record<string, unknown>> } } | undefined) : undefined
    const row = (j?.content?.vessels ?? []).find((v) => v.vesselId === TRANSPORT_ID)
    id = typeof row?.libp2p_peer_id === "string" ? row.libp2p_peer_id : ""
  }
  peer = id === "" ? undefined : { at: Date.now(), id }
  if (found !== (id !== "")) {
    found = id !== ""
    console.log(`[records] federation self peer: ${found ? "present" : "absent"} (transport named: ${TRANSPORT_ID !== "" ? "yes" : "no"})`)
  }
  return id
}

// A federation on-behalf-of token, forwarded by this node's transport: valid only when identity answers the binding for
// exactly this node and the shape being served. A session token identity accepts carries no binding and is refused, and a
// token with no caller key names nobody to write as. Identity is asked every time: a token lives seconds and each dial
// mints a new one, so a cached answer would only ever be one that outlived its token.
const onBehalfOf = async (token: string, shape: string): Promise<Known | undefined> => {
  const node = await transportPeer()
  if (node === "" || shape === "") {
    return undefined
  }
  const a = await ask({ type: "session", token, audience: { node, shape } })
  if (a === undefined || a.data.obo?.node !== node || a.data.obo?.shape !== shape || !a.data.keyId) {
    return undefined
  }
  return { keyId: String(a.data.keyId), ...kindOf(a) }
}

export const authenticate = async (req: Request, shape: string, fresh = false): Promise<Who> => {
  const bearer = /^Bearer (\S+)$/.exec(header(req))
  if (bearer !== null) {
    const found = await onBehalfOf(bearer[1] as string, shape)
    return found === undefined ? { ok: false, self: false, keyId: "" } : { ok: true, self: false, ...found, obo: true }
  }
  const key = keyOf(req)
  if (timingSafeEqual(digest(key), OWN)) {
    return { ok: true, self: true, keyId: "" }
  }
  const found = await validate(key, fresh)
  if (found === undefined) {
    return { ok: false, self: false, keyId: "" }
  }
  return { ok: true, self: false, ...found }
}

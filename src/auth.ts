// SPDX-License-Identifier: MIT
import { timingSafeEqual } from "node:crypto"
import { DISCOVERY_URL, IDENTITY_URL, KEY, TRANSPORT_ID } from "./config"
import { DISCOVERY_RESOLVE, IDENTITY_RESOLVE } from "./routes"
import { keeper, type Verdict } from "./identity-ask"
import { oboKeyOf } from "./obo-key"
import { AUTHENTICATION } from "./shapes"

// obo: the caller came from another node, with an on-behalf-of token its transport forwarded (who.keyId is the caller's key).
// ownerKind: the key's class as identity marks it (person, operator, ...); records stamps a person's row only for "person".
// orgId: the org identity found for the caller's key (for an on-behalf-of token, the org the minting identity signed into
// it from the caller's key), never a value the sender states.
// userId: the user identity says the key belongs to (its api_key row's user), when it says one; never the keyId in its
// place, and never a value the sender states.
export type Who = { ok: boolean; self: boolean; keyId: string; obo?: boolean; ownerKind?: string; orgId?: string; userId?: string }
type Answer = { success: boolean; data: { authenticated: boolean; keyId: string; ownerKind?: unknown; orgId?: unknown; userId?: unknown; obo?: { node: string; shape: string; expires_at?: string } } }
type Known = { keyId: string; ownerKind?: string; orgId?: string; userId?: string }
const kindOf = (a: Answer): { ownerKind?: string; orgId?: string; userId?: string } => ({
  ...(typeof a.data.ownerKind === "string" ? { ownerKind: a.data.ownerKind } : {}),
  ...(typeof a.data.orgId === "string" && a.data.orgId !== "" ? { orgId: a.data.orgId } : {}),
  ...(typeof a.data.userId === "string" && a.data.userId !== "" ? { userId: a.data.userId } : {}),
})

// Each key's answer is kept for reads, so identity is not asked on every read. A write asks identity afresh (fresh): a
// key's class decides whether its row is a person's, so a mark identity gives or takes back counts from the next write,
// not from the next restart.
const known = new Map<string, Known>()

const digest = (key: string): Buffer => new Bun.CryptoHasher("sha256").update(key).digest()

const OWN = digest(KEY)

const header = (req: Request): string => String(req.headers.get("authorization"))

export const keyOf = (req: Request): string => header(req).split(" ").slice(1).join(" ")

// Identity's answer: yes; no (it did not authenticate, or said 401/403); or transient (any other status). An ask that
// throws (no answer at all) throws to every caller waiting on it, as before.
const ask = async (pointer: Record<string, unknown>): Promise<Verdict<Answer>> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { type: AUTHENTICATION, pointer } }),
    timeout: false,
  }
  const r = await fetch(new URL(IDENTITY_RESOLVE, IDENTITY_URL).href, init)
  if (!r.ok) {
    return r.status === 401 || r.status === 403 ? { no: true } : { transient: true }
  }
  const a = (await r.json()) as Answer
  if (!a.success || !a.data.authenticated) {
    return { no: true }
  }
  return { yes: a }
}

const asked = keeper<Answer>()

const validate = async (key: string, fresh = false): Promise<Known | undefined> => {
  const h = digest(key).toString("hex")
  const hit = known.get(h)
  if (hit !== undefined && !fresh) {
    return hit
  }
  const v = await asked(`key:${h}`, () => ask({ type: "apiKey", apiKey: key }), { fresh })
  if (!("yes" in v)) {
    return undefined
  }
  const a = v.yes
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
  const v = await ask({ type: "apiKey", apiKey: KEY }).catch(() => undefined)
  const a = v !== undefined && "yes" in v ? v.yes : undefined
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
// token with no caller key names nobody to write as. A yes is kept for the token, its node and its shape, and never past
// the expiry identity states for the token (a token lives seconds; one with no stated expiry is asked every time). A
// write asks afresh, as a key's write does.
const onBehalfOf = async (token: string, shape: string, fresh = false): Promise<Known | undefined> => {
  const node = await transportPeer()
  if (node === "" || shape === "") {
    return undefined
  }
  const v = await asked(oboKeyOf(digest(token).toString("hex"), node, shape), () => ask({ type: "session", token, audience: { node, shape } }), {
    fresh,
    keepYes: true,
    yesUntil: (x) => {
      const t = Date.parse(String(x.data.obo?.expires_at ?? ""))
      return Number.isFinite(t) ? t : undefined
    },
  })
  const a = "yes" in v ? v.yes : undefined
  if (a === undefined || a.data.obo?.node !== node || a.data.obo?.shape !== shape || !a.data.keyId) {
    return undefined
  }
  return { keyId: String(a.data.keyId), ...kindOf(a) }
}

export const authenticate = async (req: Request, shape: string, fresh = false): Promise<Who> => {
  const bearer = /^Bearer (\S+)$/.exec(header(req))
  if (bearer !== null) {
    const found = await onBehalfOf(bearer[1] as string, shape, fresh)
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

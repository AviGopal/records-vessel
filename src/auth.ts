// SPDX-License-Identifier: MIT
import { timingSafeEqual } from "node:crypto"
import { DISCOVERY_URL, IDENTITY_URL, KEY, TRANSPORT_ID } from "./config"
import { DISCOVERY_RESOLVE, IDENTITY_RESOLVE } from "./routes"
import { AUTHENTICATION } from "./shapes"

// obo: the caller came from another node, with an on-behalf-of token its transport forwarded (who.keyId is the caller's key).
export type Who = { ok: boolean; self: boolean; keyId: string; obo?: boolean }
type Answer = { success: boolean; data: { authenticated: boolean; keyId: string; obo?: { node: string; shape: string } } }

const known = new Map<string, string>()

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

const validate = async (key: string): Promise<string | undefined> => {
  const h = digest(key).toString("hex")
  const hit = known.get(h)
  if (hit !== undefined) {
    return hit
  }
  const a = await ask({ type: "apiKey", apiKey: key })
  if (a === undefined) {
    return undefined
  }
  known.set(h, String(a.data.keyId))
  return String(a.data.keyId)
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
const onBehalfOf = async (token: string, shape: string): Promise<string | undefined> => {
  const node = await transportPeer()
  if (node === "" || shape === "") {
    return undefined
  }
  const a = await ask({ type: "session", token, audience: { node, shape } })
  if (a === undefined || a.data.obo?.node !== node || a.data.obo?.shape !== shape || !a.data.keyId) {
    return undefined
  }
  return String(a.data.keyId)
}

export const authenticate = async (req: Request, shape: string): Promise<Who> => {
  const bearer = /^Bearer (\S+)$/.exec(header(req))
  if (bearer !== null) {
    const keyId = await onBehalfOf(bearer[1] as string, shape)
    return keyId === undefined ? { ok: false, self: false, keyId: "" } : { ok: true, self: false, keyId, obo: true }
  }
  const key = keyOf(req)
  if (timingSafeEqual(digest(key), OWN)) {
    return { ok: true, self: true, keyId: "" }
  }
  const keyId = await validate(key)
  if (keyId === undefined) {
    return { ok: false, self: false, keyId: "" }
  }
  return { ok: true, self: false, keyId }
}

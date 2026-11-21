// SPDX-License-Identifier: MIT
import { type Who, authenticate, ownOrg } from "./auth"
import { DISCOVERY_URL, KEY, PORT, VESSEL_ID } from "./config"
import { costed } from "./cost"
import { SERVED_BY_MS, SUMMARY_ANSWERS, SUMMARY_DESCRIPTION, SUMMARY_INPUTS, serveSummary, unheld } from "./summary"
import { foldFrom, tally } from "./fold"
import { beat, register } from "./heartbeat"
import { DISCOVERY_RESOLVE, HEALTH, SERVE } from "./routes"
import { onServeError } from "./serve-error"
import { GAP, OPERATOR, OUTCOME, OWNER, PEER, PERSON, POSTERIOR, RECORD_LAPSED, RECORD_READ, RECORD_SUMMARY, RECORD_WAIT, RECORD_WAIT_EXACT, RECORD_WRITE, UNMARKED } from "./shapes"
import { dispatch } from "./dispatch"
import { type Query, lapsed, lastSeq, rows, serveRead, unnarrowed, waitAsked, waitExact, write } from "./store"

type Pointer = Query & {
  type: string
  row: Record<string, unknown>
  shapes: string[]
  cells: string[]
  as_of_seq: number
  until?: number
  writer?: string
  role?: string
  deadline_shape?: string
  asks?: unknown
  answer_shape?: string
}
type Handler = (p: Pointer, who: Who) => Promise<Response>

const fail = (status: number, body: string): Response => Response.json({ failure: { status, body } }, { status })

const answer = (status: number, value: unknown): Response => Response.json(value, { status })

// Why a write from another node is not taken, or undefined when it is. One org is one unit: a write from another node of
// this records' org is taken exactly as that key's write would be on its own node, and nothing more. Both orgs are the
// ones identity answers (the caller's signed into its token from its key, this records' from its own key), never one a
// sender states. A key identity marks as a person's writes a person's row, as on its own node. A key it marks as another
// node's (peer) writes that node's rows under their declared writer and role, as a node's own key does on its own
// records, except the rows only this node writes for itself (its owner's configuration) and rows no node key may declare
// (a person's, an operator's). An operator's key writes on its own node only, and a key identity marks as neither is no
// one's: neither crosses.
const crossNode = async (p: Pointer, who: Who): Promise<string | undefined> => {
  const mine = await ownOrg()
  if (mine === undefined || who.orgId === undefined) {
    return `a cross-node write needs both orgs (the caller's: ${who.orgId === undefined ? "not answered" : "answered"}, this records': ${mine === undefined ? "not answered" : "answered"})`
  }
  if (who.orgId !== mine) {
    return "a cross-node write is taken only from this records' org"
  }
  if (who.ownerKind === PERSON) {
    return undefined
  }
  if (who.ownerKind !== PEER) {
    return "a cross-node write needs a key identity marks as a person's or another node's"
  }
  if ([PERSON, OPERATOR, OWNER].includes(String(p.role))) {
    return "another node writes its own rows, never a person's, an operator's or this node's owner rows"
  }
  return undefined
}

// The vessels discovery says serve a shape (shapeProducers), by id; undefined when it does not answer, or not in time.
const producersOf = async (shape: string): Promise<string[] | undefined> => {
  const r = await fetch(new URL(DISCOVERY_RESOLVE, DISCOVERY_URL).href, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${KEY}` },
    body: JSON.stringify({ pointer: { type: "shapeProducers", shape } }),
    signal: AbortSignal.timeout(SERVED_BY_MS),
  }).catch(() => undefined)
  const j = r?.ok ? ((await r.json().catch(() => undefined)) as { content?: { vesselIds?: unknown } } | undefined) : undefined
  const ids = j?.content?.vesselIds
  return Array.isArray(ids) && ids.every((x) => typeof x === "string") ? ids : undefined
}

const HANDLERS = new Map<string, Handler>([
  [RECORD_WRITE, async (p, who) => {
    if (who.obo === true) {
      const refused = await crossNode(p, who)
      if (refused !== undefined) {
        // Said where an operator reads it: the transport's ingress cannot tell this 403 from a stored write (the answer
        // has no top-level error). The reason and the shape only, never the caller's key, token or org.
        console.log(`[records] refused a cross-node write: ${refused} (shape=${String(p.row?.shape ?? "").replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 64)})`)
        return fail(403, refused)
      }
      if (who.ownerKind === PEER) {
        if (p.writer === undefined || p.role === undefined) {
          return fail(400, RECORD_WRITE)
        }
        // Which key wrote it is records' to say, from the token, never the sender's: a node key is held by every vessel on
        // its node, so this is what tells one node's rows from another's in one store.
        const out = write({ ...p.row, by_key: who.keyId }, String(p.writer), String(p.role))
        return answer(out.status, out.body)
      }
      // A person's key from another node of this org: written below, as a person's key on this node is.
    }
    if (!who.self) {
      // A gap is a detector's observation on this node. Under a person's key it would be stamped a person row, an open
      // request the walk would work: a forged ask. Only the node's own key writes one.
      if (String(p.row?.shape) === GAP) {
        return fail(403, "a gap row is written only under the node's own key")
      }
      // A person's row only under a key identity marks as a person's own; an operator's only under a key it marks as an
      // operator's (its asks are asks, never a person's verdict). Any other key (unclassified, a peer's, an agent's
      // cockpit key identity has not marked, or one it said nothing of) writes an unmarked row: stored, but no ask until
      // identity marks the key. Which keys may ask is identity's mark, read at each write, never a list here.
      const role = who.ownerKind === PERSON ? PERSON : who.ownerKind === OPERATOR ? OPERATOR : UNMARKED
      // A grade from a key identity does not mark as a person's is written as that key's class: never silently. Said
      // where an operator reads it, by the shape and the class identity gave (never the key).
      if (role !== PERSON && String(p.row?.shape) === OUTCOME) {
        console.log(`[records] an outcome from a key not marked a person's was written as ${role} (class=${String(who.ownerKind ?? "none").replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 32)})`)
      }
      // The user identity says the key belongs to: write() stamps it on a person's row only (store.ts user_id).
      const out = write(p.row, who.keyId, role, who.userId)
      return answer(out.status, out.body)
    }
    if (p.writer === undefined || p.role === undefined) {
      return fail(400, RECORD_WRITE)
    }
    // A person row is one identity stamped from the person's own key, above. The node key is held by every vessel on
    // the node, so a person row declared under it could be anyone's, and a verdict that only a person may give
    // (closing a request, approving a landing) could be forged.
    if (String(p.role) === PERSON) {
      return fail(403, "a person row is written only under the person's own key")
    }
    const out = write(p.row, String(p.writer), String(p.role))
    return answer(out.status, out.body)
  }],
  // The head alone (head: true) folds nothing and answers the latest seq alone, with no cost beside it.
  [RECORD_READ, async (p) => {
    const refused = unnarrowed(p as Query)
    if (refused !== undefined) return Response.json({ failure: { status: 400, body: refused } }, { status: 400 })
    return answer(200, p.head === true ? serveRead(p) : costed(RECORD_READ, p, () => serveRead(p)))
  }],
  [RECORD_WAIT, async (p) => answer(200, await waitAsked(p))],
  [RECORD_WAIT_EXACT, async (p) => answer(200, await waitExact(p.shapes, Number(p.after_seq), p.where))],
  [RECORD_LAPSED, async (p) => {
    if (p.deadline_shape === undefined || p.answer_shape === undefined) {
      return fail(400, RECORD_LAPSED)
    }
    return answer(200, costed(RECORD_LAPSED, p, () => lapsed(String(p.deadline_shape), String(p.answer_shape), Date.now(), Array.isArray(p.asks) ? p.asks.map(String) : undefined)))
  }],
  // Who serves a shape no row holds is joined for this node's own callers only: discovery is read under the node key,
  // which sees every org's vessels, so another key is told held: false alone, which says no more than its count.
  [RECORD_SUMMARY, async (p, who) =>
    answer(200, await unheld(costed(RECORD_SUMMARY, p, () => serveSummary(rows, p as Record<string, unknown>)), who.self ? producersOf : undefined))],
  [POSTERIOR, async (p) => {
    const at = lastSeq()
    return answer(200, costed(POSTERIOR, { as_of_seq: p.as_of_seq, cells: [p.cells ?? []].flat().length }, () =>
      ({ at_seq: at, posts: foldFrom(rows, p.cells ?? [], Number(p.as_of_seq), at), grades: tally(rows, Number(p.as_of_seq), at) })))
  }],
])

const handle = async (req: Request): Promise<Response> => {
  // The body is read before authenticating because an on-behalf-of token is good for one shape only; an unreadable body
  // still answers 401 to an unauthenticated caller before it answers 400.
  const body = (await req.json().catch(() => undefined)) as { impulse?: { pointer?: Pointer } } | undefined
  const type = String(body?.impulse?.pointer?.type ?? "")
  const who = await authenticate(req, type, type === RECORD_WRITE)
  if (!who.ok) {
    return fail(who.transient === true ? 503 : 401, "")
  }
  const p = body?.impulse?.pointer
  if (p === undefined || typeof p !== "object" || p === null || !HANDLERS.has(p.type)) {
    return fail(400, type)
  }
  return dispatch(p, who, HANDLERS)
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: { [SERVE]: { POST: handle }, [HEALTH]: { GET: () => Response.json({ vessel: VESSEL_ID }) } },
  fetch: () => fail(404, ""),
  error: onServeError,
})
// Only record_summary is declared, so a schema-filling caller (the walk's request producer) is offered counts of what
// rows hold, by a shape that never answers a row; record_read stays undeclared (summary.ts).
await register([RECORD_WRITE, RECORD_READ, RECORD_WAIT, RECORD_WAIT_EXACT, RECORD_LAPSED, POSTERIOR, RECORD_SUMMARY], {
  shape_inputs: { [RECORD_SUMMARY]: SUMMARY_INPUTS }, shape_descriptions: { [RECORD_SUMMARY]: SUMMARY_DESCRIPTION }, shape_answers: { [RECORD_SUMMARY]: SUMMARY_ANSWERS },
})
await beat()

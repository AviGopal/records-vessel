// SPDX-License-Identifier: MIT
import { type Who, authenticate } from "./auth"
import { PORT, VESSEL_ID } from "./config"
import { foldFrom, tally } from "./fold"
import { beat, register } from "./heartbeat"
import { HEALTH, SERVE } from "./routes"
import { GAP, OPERATOR, OUTCOME, PERSON, POSTERIOR, RECORD_LAPSED, RECORD_READ, RECORD_WAIT, RECORD_WAIT_EXACT, RECORD_WRITE, UNMARKED } from "./shapes"
import { type Query, lapsed, lastSeq, rows, serveRead, wait, waitExact, write } from "./store"

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

const HANDLERS = new Map<string, Handler>([
  [RECORD_WRITE, async (p, who) => {
    // A write from another node is refused until identity marks whose key it is. Taken as a person row it would be an open
    // request the walk works and a grade the fold counts, and every vessel on the other node holds a key that can obtain
    // the token. Its declared writer and role are never read. Reads from another node are served like any caller's.
    if (who.obo === true) {
      // Said where an operator reads it: the transport's ingress cannot tell this 403 from a stored write (the answer has
      // no top-level error). The shape only, never the caller's key or token.
      console.log(`[records] refused a cross-node write: cross-node writes wait for person marking (shape=${String(p.row?.shape ?? "").replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 64)})`)
      return fail(403, "cross-node writes wait for person marking")
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
      const out = write(p.row, who.keyId, role)
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
  [RECORD_READ, async (p) => answer(200, serveRead(p))],
  [RECORD_WAIT, async (p) => answer(200, await wait(p.shapes, Number(p.after_seq), p.until === undefined ? undefined : Number(p.until)))],
  [RECORD_WAIT_EXACT, async (p) => answer(200, await waitExact(p.shapes, Number(p.after_seq), p.where))],
  [RECORD_LAPSED, async (p) => {
    if (p.deadline_shape === undefined || p.answer_shape === undefined) {
      return fail(400, RECORD_LAPSED)
    }
    return answer(200, lapsed(String(p.deadline_shape), String(p.answer_shape), Date.now(), Array.isArray(p.asks) ? p.asks.map(String) : undefined))
  }],
  [POSTERIOR, async (p) => {
    const at = lastSeq()
    return answer(200, { at_seq: at, posts: foldFrom(rows, p.cells ?? [], Number(p.as_of_seq), at), grades: tally(rows, Number(p.as_of_seq), at) })
  }],
])

const handle = async (req: Request): Promise<Response> => {
  // The body is read before authenticating because an on-behalf-of token is good for one shape only; an unreadable body
  // still answers 401 to an unauthenticated caller before it answers 400.
  const body = (await req.json().catch(() => undefined)) as { impulse?: { pointer?: Pointer } } | undefined
  const type = String(body?.impulse?.pointer?.type ?? "")
  const who = await authenticate(req, type, type === RECORD_WRITE)
  if (!who.ok) {
    return fail(401, "")
  }
  try {
    const p = (body as { impulse: { pointer: Pointer } }).impulse.pointer
    if (!HANDLERS.has(p.type)) {
      return fail(400, p.type)
    }
    const h = HANDLERS.get(p.type) as Handler
    return await h(p, who)
  } catch (e) {
    return Response.json({ failure: { status: 400, body: String(e) } }, { status: 400 })
  }
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: { [SERVE]: { POST: handle }, [HEALTH]: { GET: () => Response.json({ vessel: VESSEL_ID }) } },
  fetch: () => fail(404, ""),
  error: (e) => {
    console.error(String(e))
    process.exit(1)
  },
})
await register([RECORD_WRITE, RECORD_READ, RECORD_WAIT, RECORD_WAIT_EXACT, RECORD_LAPSED, POSTERIOR])
await beat()

// SPDX-License-Identifier: MIT
import { type Who, authenticate } from "./auth"
import { PORT, VESSEL_ID } from "./config"
import { foldFrom } from "./fold"
import { beat, register } from "./heartbeat"
import { HEALTH, SERVE } from "./routes"
import { GAP, PERSON, POSTERIOR, RECORD_LAPSED, RECORD_READ, RECORD_WAIT, RECORD_WAIT_EXACT, RECORD_WRITE } from "./shapes"
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
  answer_shape?: string
}
type Handler = (p: Pointer, who: Who) => Promise<Response>

const fail = (status: number, body: string): Response => Response.json({ failure: { status, body } }, { status })

const answer = (status: number, value: unknown): Response => Response.json(value, { status })

const HANDLERS = new Map<string, Handler>([
  [RECORD_WRITE, async (p, who) => {
    if (!who.self) {
      // A gap is a detector's observation on this node. Under a person's key it would be stamped a person row, an open
      // request the walk would work: a forged ask. Only the node's own key writes one.
      if (String(p.row?.shape) === GAP) {
        return fail(403, "a gap row is written only under the node's own key")
      }
      const out = write(p.row, who.keyId, PERSON)
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
    return answer(200, lapsed(String(p.deadline_shape), String(p.answer_shape), Date.now()))
  }],
  [POSTERIOR, async (p) => {
    const at = lastSeq()
    return answer(200, { at_seq: at, posts: foldFrom(rows, p.cells, Number(p.as_of_seq), at) })
  }],
])

const handle = async (req: Request): Promise<Response> => {
  const who = await authenticate(req)
  if (!who.ok) {
    return fail(401, "")
  }
  try {
    const p = ((await req.json()) as { impulse: { pointer: Pointer } }).impulse.pointer
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

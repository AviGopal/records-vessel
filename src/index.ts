// SPDX-License-Identifier: MIT
import { type Who, authenticate } from "./auth"
import { PORT, VESSEL_ID } from "./config"
import { fold } from "./fold"
import { beat, register } from "./heartbeat"
import { HEALTH, SERVE } from "./routes"
import { PERSON, POSTERIOR, RECORD_READ, RECORD_WAIT, RECORD_WAIT_EXACT, RECORD_WRITE } from "./shapes"
import { type Query, lastSeq, rows, serveRead, wait, waitExact, write } from "./store"

type Pointer = Query & {
  type: string
  row: Record<string, unknown>
  shapes: string[]
  cells: string[]
  as_of_seq: number
  writer?: string
  role?: string
}
type Handler = (p: Pointer, who: Who) => Promise<Response>

const fail = (status: number, body: string): Response => Response.json({ failure: { status, body } }, { status })

const answer = (status: number, value: unknown): Response => Response.json(value, { status })

const HANDLERS = new Map<string, Handler>([
  [RECORD_WRITE, async (p, who) => {
    if (!who.self) {
      const out = write(p.row, who.keyId, PERSON)
      return answer(out.status, out.body)
    }
    if (p.writer === undefined || p.role === undefined) {
      return fail(400, RECORD_WRITE)
    }
    const out = write(p.row, String(p.writer), String(p.role))
    return answer(out.status, out.body)
  }],
  [RECORD_READ, async (p) => answer(200, serveRead(p))],
  [RECORD_WAIT, async (p) => answer(200, await wait(p.shapes, Number(p.after_seq)))],
  [RECORD_WAIT_EXACT, async (p) => answer(200, await waitExact(p.shapes, Number(p.after_seq), p.where))],
  [POSTERIOR, async (p) => {
    const at = lastSeq()
    return answer(200, { at_seq: at, posts: fold(rows, p.cells, Number(p.as_of_seq), at) })
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
await register([RECORD_WRITE, RECORD_READ, RECORD_WAIT, RECORD_WAIT_EXACT, POSTERIOR])
await beat()

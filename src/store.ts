// SPDX-License-Identifier: MIT
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR } from "./config"
import { grades } from "./fold"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, DESCRIBED, FAILURE, HOP, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, SHAPE_SCHEMA,
} from "./shapes"

export type Row = { shape: string; id: string; seq: number; t: string; writer: string; role: string; input_refs: string[]; [k: string]: unknown }
export type Query = {
  shape?: string
  ids?: string[]
  after_seq?: number
  refs_to?: string
  where?: Record<string, unknown>
  episode?: string
}

const OWNER_SHAPES = new Set([CHANNEL, SHAPE_SCHEMA, ARM, PRIOR])
const EXO_ROLES = new Set([PERSON, OWNER])
const MINE = new Set([SELECTION, HOP, FAILURE])
const FILE = join(DATA_DIR, "rows")

appendFileSync(FILE, "")
export const rows: Row[] = (await Bun.file(FILE).text())
  .split("\n")
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l) as Row)
let seq = rows.length
let wakers: Array<() => void> = []

export const write = (body: Record<string, unknown>, writer: string, role: string): { status: number; body: unknown } => {
  if (OWNER_SHAPES.has(String(body.shape))) {
    if (role !== OWNER) {
      return { status: 403, body: { failure: { status: 403, body: role } } }
    }
  }
  if (role === DESCRIBED) {
    const sels = rows.filter((r) => r.shape === SELECTION).filter((r) => r.id === String(body.selection_ref))
    if (sels.length === 0) {
      return { status: 403, body: { failure: { status: 403, body: role } } }
    }
  }
  seq = seq + 1
  const t = new Date().toISOString()
  // A row that states how long it allows (within_ms) gets its deadline `at` from records' own clock, never from the
  // writer: a producer has no clock, and a deadline it guessed was a day off.
  const within = Number(body.within_ms)
  const deadline = typeof body.within_ms === "number" && Number.isFinite(within) && within >= 0 ? { at: Date.parse(t) + within } : {}
  const unsigned = { input_refs: [], ...body, ...deadline, seq, t, writer, role }
  const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(unsigned)).digest("hex")
  const row: Row = { ...unsigned, shape: String(body.shape), id }
  appendFileSync(FILE, `${JSON.stringify(row)}\n`)
  rows.push(row)
  const woken = wakers
  wakers = []
  for (const f of woken) {
    f()
  }
  return { status: 200, body: row }
}

export const read = (q: Query): Row[] => {
  let out = rows
  if (q.shape !== undefined) {
    const s = String(q.shape)
    out = out.filter((r) => r.shape === s)
  }
  if (q.ids !== undefined) {
    const s = new Set(q.ids)
    out = out.filter((r) => s.has(r.id))
  }
  if (q.after_seq !== undefined) {
    const n = Number(q.after_seq)
    out = out.filter((r) => r.seq > n)
  }
  if (q.refs_to !== undefined) {
    const s = String(q.refs_to)
    out = out.filter((r) => [r.input_refs].flat().includes(s))
  }
  if (q.where !== undefined) {
    for (const [k, v] of Object.entries(q.where)) {
      const s = String(v)
      out = out.filter((r) => String(r[k]) === s)
    }
  }
  return out
}

const exogenous = (from: Row[]): Row[] =>
  from.filter((r) => EXO_ROLES.has(r.role)).filter((r) => !OWNER_SHAPES.has(r.shape))

// A request is closed when a counted grade says how it ended (fold.ts grades, the fold's own predicate): DONE by a
// person's verdict at r 1 on an answer to it; FAILED by a lapse (a counted r 0 on its deadline row). A described
// outcome at r 1 is the walk grading its own answer and does not close a request: an independent grade (by information,
// not only by a person) would, and is not built yet. "Answers it" is provenance: the judged row cites the request in
// its input_refs.
const closed = (): Set<string> => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = new Set<string>()
  for (const g of grades(rows, seq, seq).filter((k) => k.ok)) {
    const ends = (g.r === 1 && g.by === PERSON) || (g.r === 0 && g.deadline)
    if (ends) for (const id of [byId.get(g.judged)?.input_refs].flat()) out.add(String(id))
  }
  return out
}

// The episode a walk works: the OLDEST open request (an exogenous row that is not a grade and is not closed), so a
// newer request never evicts an older one and a closed one never blocks the next; with none open, the walk's newest
// arm row, as it idles. It holds the rows descended from that root: the walk's selections whose pool held it, their
// hops and failures, the described rows those selections made, and the owner's channels, schemas and the walk's
// templates. A newer request's work is not in an older root's episode.
export const episode = (w: string): Row[] => {
  const arms = rows.filter((r) => r.shape === ARM).filter((r) => r.role === OWNER).filter((r) => String(r.vessel_id) === w)
  const done = closed()
  const open = exogenous(rows).filter((r) => r.shape !== OUTCOME).filter((r) => !done.has(r.id))
  const root = open[0] ?? arms[arms.length - 1]
  const allSels = new Set(rows.filter((r) => r.shape === SELECTION).filter((r) => r.writer === w).map((r) => r.id))
  const mine = rows.filter((r) => MINE.has(r.shape)).filter((r) => r.writer === w)
  const held = (r: Row): boolean => root !== undefined && [r.pool_refs, r.input_refs].flat().map(String).includes(root.id)
  const sels = new Set(mine.filter((r) => r.shape === SELECTION).filter(held).map((r) => r.id))
  const keep = new Set([
    ...(root ? [root] : []),
    ...mine.filter((r) => sels.has(r.shape === SELECTION ? r.id : String(r.selection_ref))),
    ...rows.filter((r) => r.role === DESCRIBED).filter((r) => r.shape !== ACTIVITY_TEMPLATE).filter((r) => sels.has(String(r.selection_ref))),
    ...rows.filter((r) => r.role === OWNER).filter((r) => r.shape === CHANNEL),
    ...rows.filter((r) => r.role === OWNER).filter((r) => r.shape === SHAPE_SCHEMA),
    ...rows.filter((r) => r.shape === ACTIVITY_TEMPLATE).filter((r) => r.role === DESCRIBED)
      .filter((r) => allSels.has(String(r.selection_ref))),
  ].map((r) => r.id))
  return rows.filter((r) => keep.has(r.id))
}

const until = async (scan: () => Row[]): Promise<Row> => {
  const hits = scan()
  if (hits.length > 0) {
    return hits[0]
  }
  await new Promise<void>((resolve) => {
    wakers.push(resolve)
  })
  return until(scan)
}

// A wait answers the first row of the shapes asked for (or any exogenous row) after afterSeq. Given a deadline (the
// caller's `until`, ms since the epoch, taken from its own rows), it answers null at that time: "nothing yet". Without
// one it waits for a row, as before; nothing here sets a bound of its own.
export const wait = (shapes: string[], afterSeq: number, deadline?: number): Promise<Row | null> => {
  const found = until(() => {
    const after = rows.filter((r) => r.seq > afterSeq)
    const want = new Set(shapes)
    const hits = new Set([...after.filter((r) => want.has(r.shape)), ...exogenous(after)].map((r) => r.id))
    return after.filter((r) => hits.has(r.id))
  })
  if (deadline === undefined || !Number.isFinite(deadline)) {
    return found
  }
  return Promise.race([found, new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())))])
}

export const waitExact = (shapes: string[], afterSeq: number, where: Record<string, unknown> | undefined): Promise<Row> =>
  until(() => {
    const want = new Set(shapes)
    return read({ after_seq: afterSeq, where }).filter((r) => want.has(r.shape))
  })

export const lastSeq = (): number => seq

// A deadline row (described, with a within_ms records turned into `at`) has lapsed when its time has passed, no
// answer row shares its request (the person row both cite), and no grade the fold counts has judged it yet (one
// predicate, fold.ts grades): a grade the fold refuses, early or otherwise, does not hide the lapse.
// The two shapes come from the caller's pointer, so the owner's schema row decides what a deadline and an answer are.
export const lapsed = (deadlineShape: string, answerShape: string, now: number): Row[] => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const asks = (r: Row): string[] => [r.input_refs].flat().map(String).filter((id) => byId.get(id)?.role === PERSON)
  const answered = new Set(rows.filter((r) => r.shape === answerShape).filter((r) => r.role === DESCRIBED).flatMap(asks))
  const judged = new Set(grades(rows, seq, seq).filter((k) => k.ok).map((k) => k.judged))
  return rows
    .filter((r) => r.shape === deadlineShape)
    .filter((r) => r.role === DESCRIBED)
    .filter((r) => typeof r.within_ms === "number" && typeof r.at === "number" && r.at < now)
    .filter((r) => !asks(r).some((id) => answered.has(id)))
    .filter((r) => !judged.has(r.id))
}

export const serveRead = (q: Query): Row[] => {
  if (q.episode !== undefined) {
    return episode(q.episode)
  }
  return read(q)
}

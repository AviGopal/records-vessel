// SPDX-License-Identifier: MIT
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR } from "./config"
import { blames, standing } from "./fold"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, CREDITS, DESCRIBED, DETECTOR, FAILURE, GAP, HOP, OUTCOME, OWNER, PERSON, PRIOR, REPOSITORY, REQUIRES, SELECTION, SHAPE_SCHEMA, SHAPE_DESCRIPTION, WALK,
} from "./shapes"

export type Row = { shape: string; id: string; seq: number; t: string; writer: string; role: string; input_refs: string[]; [k: string]: unknown }
export type Query = {
  shape?: string
  ids?: string[]
  after_seq?: number
  refs_to?: string
  where?: Record<string, unknown>
  episode?: string
  roots?: string
  calls?: string[]
  latest_by?: string
}

const OWNER_SHAPES = new Set([CHANNEL, SHAPE_SCHEMA, SHAPE_DESCRIPTION, ARM, PRIOR, REQUIRES, CREDITS, REPOSITORY])
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
  // A walk's failure row carries whom it blames, decided by records (fold.ts blames), never by the writer.
  const blame = String(body.shape) === FAILURE && role === WALK ? { blames: blames(body) } : {}
  const unsigned = { input_refs: [], ...body, ...deadline, ...blame, seq, t, writer, role }
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
  // The latest row of each value of a field (a gap's gap_id): what each one stands at now. Kept before where, so a thing
  // whose latest row no longer matches (a gap closed since) shows nothing, not an older row that once matched.
  if (q.latest_by !== undefined) {
    const key = String(q.latest_by)
    const latest = new Map<string, Row>()
    for (const r of out.filter((x) => x[key] !== undefined)) latest.set(String(r[key]), r)
    out = [...latest.values()].sort((a, b) => a.seq - b.seq)
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

// A request is closed when a grade that stands says how it ended (fold.ts standing, the fold's own predicate: of a
// writer's grades of one answer only the latest stands): DONE by a
// person's verdict at r 1 on an answer to it; FAILED by a lapse (a counted r 0 on its deadline row). A described
// outcome at r 1 is the walk grading its own answer and does not close a request: an independent grade (by information,
// not only by a person) would, and is not built yet. "Answers it" is provenance: the judged row cites the request in
// its input_refs.
const closed = (): Set<string> => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = new Set<string>()
  for (const g of standing(rows, seq, seq)) {
    const ends = (g.r === 1 && g.by === PERSON) || (g.r === 0 && g.deadline)
    if (ends) for (const id of [byId.get(g.judged)?.input_refs].flat()) out.add(String(id))
  }
  return out
}

// The single episode (the old read form, unchanged): the OLDEST open request (an exogenous row that is not a grade and is not closed), so a
// newer request never evicts an older one and a closed one never blocks the next; with none open, the walk's newest
// arm row, as it idles. It holds the rows descended from that root: the walk's selections whose pool held it, their
// hops and failures, the described rows those selections made, and the owner's channels, schemas and the walk's
// templates. A newer request's work is not in an older root's episode.
// A gap a detector found is work too, though no one asked: while the latest detector row for its gap_id says open (and
// no hold is on it), that row is a root, worked as a request is. Only a detector closes it (a later row of the same gap_id that is not open: its
// check passed), never a grade or anything the walk writes, so the gap stays work until the check says it is fixed.
const openGaps = (from: Row[]): Row[] => {
  const latest = new Map<string, Row>()
  for (const r of from.filter((x) => x.shape === GAP && x.role === DETECTOR && x.gap_id !== undefined)) latest.set(String(r.gap_id), r)
  // A gap held by a person (operator_hold on its latest row, kept in its meta by the detector) is no one's work until
  // the hold lifts: it is not a root.
  const held = (r: Row): boolean => r.operator_hold === true || (r.meta as { operator_hold?: unknown } | undefined)?.operator_hold === true
  return [...latest.values()].filter((r) => r.status === "open" && !held(r))
}

// A row that carries a verdict (r 0 or 1 on rows it cites) judges something: it is a grade, whatever its shape, not a
// request. A person's verdict on a change (a land_verdict citing its diff) is one; were it a root, nothing would ever
// close it, since what closes a request is a grade of an answer to it.
const verdict = (r: Row): boolean => (r.r === 0 || r.r === 1) && [r.input_refs].flat().filter((x) => x !== undefined).length > 0

const openRoots = (w: string): Row[] => {
  const done = closed()
  const open = [...exogenous(rows).filter((r) => r.shape !== OUTCOME).filter((r) => !verdict(r)).filter((r) => !done.has(r.id)), ...openGaps(rows)]
    .sort((a, b) => a.seq - b.seq)
  if (open.length > 0) return open
  const arms = rows.filter((r) => r.shape === ARM).filter((r) => r.role === OWNER).filter((r) => String(r.vessel_id) === w)
  return arms.slice(-1)
}

// The rows descended from one root: it, the walk's selections whose pool held it, their hops and failures, the
// described rows those selections made, and the rows the walk recorded from a tool's answer for them (a gitDiff).
const rootRows = (w: string, root: Row): Row[] => {
  const mine = rows.filter((r) => MINE.has(r.shape)).filter((r) => r.writer === w)
  const held = (r: Row): boolean => [r.pool_refs, r.input_refs].flat().map(String).includes(root.id)
  const sels = new Set(mine.filter((r) => r.shape === SELECTION).filter(held).map((r) => r.id))
  const keep = new Set([
    root,
    ...mine.filter((r) => sels.has(r.shape === SELECTION ? r.id : String(r.selection_ref))),
    ...rows.filter((r) => r.role === DESCRIBED).filter((r) => r.shape !== ACTIVITY_TEMPLATE).filter((r) => sels.has(String(r.selection_ref))),
    ...rows.filter((r) => r.role === WALK && r.writer === w).filter((r) => !MINE.has(r.shape)).filter((r) => sels.has(String(r.selection_ref))),
  ].map((r) => r.id))
  return rows.filter((r) => keep.has(r.id))
}

// A template is earned, not declared (law 4): it is the walk's to run only when it replays a run that reached. Its own
// selection worked a request a person graded done (r 1, the grade that closes a request), and every call it lists, in
// order, is a call that ended in that request's work (a call or a template's call whose hop ended; the shape it called
// is on the started hop of the same call_id). A template a producer declared from anything else, a failed run or an
// ask still open, or one calling what the run never called, is not offered: it stays in the store, unread by the walk.
const earned = (w: string): (t: Row) => boolean => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const done = new Set(standing(rows, seq, seq).filter((k) => k.r === 1 && k.by === PERSON)
    .flatMap((k) => [byId.get(k.judged)?.input_refs].flat().map(String)))
  const sels = rows.filter((r) => r.shape === SELECTION && r.writer === w)
  const started = new Map(rows.filter((r) => r.shape === HOP && r.writer === w && r.phase === "started").map((r) => [String(r.call_id), String(r.pointer_type)]))
  const calledIn = (root: string): string[] => {
    const held = new Set(sels.filter((s) => [s.pool_refs].flat().map(String).includes(root)).map((s) => s.id))
    return rows
      .filter((r) => r.shape === HOP && r.writer === w && r.phase === "ended" && (r.kind === "call" || r.kind === "run") && held.has(String(r.selection_ref)))
      .map((r) => started.get(String(r.call_id)) ?? "")
  }
  const replays = (calls: string[], ran: string[]): boolean => {
    let i = 0
    for (const shape of ran) if (i < calls.length && shape === calls[i]) i++
    return calls.length > 0 && i === calls.length
  }
  return (t: Row): boolean => {
    const own = byId.get(String(t.selection_ref))
    const calls = [t.calls].flat().map((c) => String((c as { shape?: unknown } | undefined)?.shape ?? ""))
    return [own?.pool_refs].flat().map(String).filter((id) => done.has(id)).some((root) => replays(calls, calledIn(root)))
  }
}

// What every root's work shares: the owner's channels, schemas, call preconditions and repositories, and the templates
// the walk earned.
const shared = (w: string): Row[] => {
  const allSels = new Set(rows.filter((r) => r.shape === SELECTION).filter((r) => r.writer === w).map((r) => r.id))
  const ok = earned(w)
  return rows.filter((r) =>
    (r.role === OWNER && (r.shape === CHANNEL || r.shape === SHAPE_SCHEMA || r.shape === REQUIRES || r.shape === REPOSITORY)) ||
    (r.shape === ACTIVITY_TEMPLATE && r.role === DESCRIBED && allSels.has(String(r.selection_ref)) && ok(r)))
}

export const episode = (w: string): Row[] => {
  const [root] = openRoots(w)
  const keep = new Set([...(root ? rootRows(w, root) : []), ...shared(w)].map((r) => r.id))
  return rows.filter((r) => keep.has(r.id))
}

// Every open root with its own rows, oldest first, and the rows they share listed once: which request to work is the
// walk's selection to make, not this store's. With none open, the walk's newest arm, as it idles.
// Whether anyone awaits an answer on a root: a person's or the owner's request does, and so does a gap a detector opened
// (it awaits the change its check passes on); only the walk's arm does not, so only idling is waited through unbounded.
// A wait is answered by the next person or owner row, which no one writes for a detector's gap: one taken there would
// hold every root until an unrelated row came. Stated here, where roots are made, so the walk reads it and never needs
// to know a shape's name.
export const episodes = (w: string): { shared: Row[]; roots: Array<{ root: Row; rows: Row[]; awaits: boolean }> } => ({
  shared: shared(w),
  roots: openRoots(w).map((root) => ({ root, rows: rootRows(w, root), awaits: root.shape !== ARM })),
})

// Answers the first row scan finds, rescanning on every write. Given a deadline it answers null at that time and
// withdraws its waker, so a wait that ended empty stops rescanning: one left behind per timed-out wait would rescan
// every row on every later write, forever.
const until = (scan: () => Row[], deadline?: number): Promise<Row | null> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (row: Row | null): void => {
      clearTimeout(timer)
      wakers = wakers.filter((w) => w !== waker)
      resolve(row)
    }
    const waker = (): void => {
      const hits = scan()
      if (hits.length > 0) done(hits[0])
      else wakers.push(waker)
    }
    waker()
    if (deadline !== undefined && Number.isFinite(deadline)) timer = setTimeout(() => done(null), Math.max(0, deadline - Date.now()))
  })

/** How many waits are registered: a wait that answered, by a row or by its deadline, is not among them. */
export const waiting = (): number => wakers.length

// A wait answers the first row of the shapes asked for (or any exogenous row, or a detector's gap row, opening or closing
// one: either changes what the walk has to work) after afterSeq. Given a deadline (the
// caller's `until`, ms since the epoch, taken from its own rows), it answers null at that time: "nothing yet". Without
// one it waits for a row, as before; nothing here sets a bound of its own.
export const wait = (shapes: string[], afterSeq: number, deadline?: number): Promise<Row | null> =>
  until(() => {
    const after = rows.filter((r) => r.seq > afterSeq)
    const want = new Set(shapes)
    const gaps = after.filter((r) => r.shape === GAP && r.role === DETECTOR)
    const hits = new Set([...after.filter((r) => want.has(r.shape)), ...exogenous(after), ...gaps].map((r) => r.id))
    return after.filter((r) => hits.has(r.id))
  }, deadline)

export const waitExact = (shapes: string[], afterSeq: number, where: Record<string, unknown> | undefined): Promise<Row> =>
  until(() => {
    const want = new Set(shapes)
    return read({ after_seq: afterSeq, where }).filter((r) => want.has(r.shape))
  }) as Promise<Row> // no deadline: it answers a row

export const lastSeq = (): number => seq

// A deadline row (described, with a within_ms records turned into `at`) has lapsed when its time has passed, no
// answer row shares its request (the person row both cite), and no grade the fold counts has judged it yet (one
// predicate, fold.ts grades): a grade the fold refuses, early or otherwise, does not hide the lapse.
// The two shapes come from the caller's pointer, so the owner's schema row decides what a deadline and an answer are.
// of, when given, names the requests (the person or owner rows) the caller is about: only their deadlines are answered,
// so a grader of one request is never shown another's lapse.
export const lapsed = (deadlineShape: string, _answerShape: string, now: number, of?: string[]): Row[] => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const exo = new Set(exogenous(rows).map((r) => r.id))
  const asks = (r: Row): string[] => [r.input_refs].flat().map(String).filter((id) => exo.has(id))
  const judged = new Set(standing(rows, seq, seq).map((k) => k.judged))
  const done = closed()
  // A request's deadline is its FIRST deadline row: a later one, written after an answer, does not move it, or a
  // request answered only by its own walk would renew its deadline forever and never close. Only a person's verdict
  // (closed) ends it before then; an answer alone does not.
  const first = new Map<string, Row>()
  for (const r of rows.filter((x) => x.shape === deadlineShape && x.role === DESCRIBED)) {
    if (typeof r.within_ms !== "number" || typeof r.at !== "number") continue
    for (const id of asks(r)) if (!first.has(id)) first.set(id, r)
  }
  const out = new Map<string, Row>()
  for (const [ask, r] of first) {
    if (of !== undefined && !of.includes(ask)) continue
    if (done.has(ask) || judged.has(r.id) || Number(r.at) >= now || byId.get(ask) === undefined) continue
    out.set(r.id, r)
  }
  return [...out.values()]
}

// The walk's calls of the shapes a caller names, each with the root it worked for, whether that root is open, and how
// the call stands (started, ended with its output, or failed), read without the rows behind them. A reader that needs
// only which calls went where (which clone a root holds, which landed, what is in flight) reads this instead of every
// selection, hop and failure: its size grows with those calls, never with what the selections saw. Every call still in
// flight is answered too, whatever its shape: what is in flight is what such a reader must not disturb.
// The walk makes one move at a time, so only a call under its newest selection can still be in flight: one started
// under an older selection that neither ended nor failed was cut off (the walk stopped mid-call) and is abandoned. A call
// under a selection records does not hold cannot be placed (the walk writes its selection before its calls), so it is
// read as in flight: a reader keeps what it might be using rather than guess.
export type Call = { call_id: string; type: string; selection_ref: string; root: string; open: boolean; state: "started" | "ended" | "failed" | "abandoned"; seq: number; t: string; output?: unknown }
export const walkCalls = (w: string, types: string[]): Call[] => {
  const want = new Set(types.map(String))
  const open = new Set(openRoots(w).map((r) => r.id))
  const mine = rows.filter((r) => MINE.has(r.shape) && r.writer === w)
  const sels = new Map(mine.filter((r) => r.shape === SELECTION).map((s) => [s.id, s]))
  const ended = new Map(mine.filter((r) => r.shape === HOP && r.phase === "ended").map((r) => [String(r.call_id), r]))
  const failed = new Set(mine.filter((r) => r.shape === FAILURE).map((r) => String(r.call_id)))
  const newest = mine.filter((r) => r.shape === SELECTION).reduce<Row | undefined>((a, r) => (a === undefined || r.seq > a.seq ? r : a), undefined)
  const settled = (id: string) => ended.has(id) || failed.has(id)
  const live = (h: Row) => !settled(String(h.call_id)) && (String(h.selection_ref) === newest?.id || !sels.has(String(h.selection_ref)))
  return mine.filter((r) => r.shape === HOP && r.phase === "started" && (want.has(String(r.pointer_type)) || live(r))).map((h) => {
    const id = String(h.call_id)
    const root = String(sels.get(String(h.selection_ref))?.root ?? "")
    const e = ended.get(id)
    return {
      call_id: id, type: String(h.pointer_type), selection_ref: String(h.selection_ref), root, open: open.has(root),
      state: e ? "ended" : failed.has(id) ? "failed" : live(h) ? "started" : "abandoned", seq: h.seq, t: h.t, ...(e ? { output: e.output } : {}),
    }
  })
}

export const serveRead = (q: Query): Row[] | Call[] | ReturnType<typeof episodes> => {
  if (q.episode !== undefined && Array.isArray(q.calls)) return walkCalls(q.episode, q.calls)
  if (q.episode !== undefined) {
    return q.roots === "all" ? episodes(q.episode) : episode(q.episode)
  }
  return read(q)
}

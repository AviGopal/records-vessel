// SPDX-License-Identifier: MIT
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DATA_DIR, VESSEL_ID } from "./config"
import { checker } from "./self-check"
import { rowsIn } from "./rows-file"
import { deadlineAsks, declaredAsks, exogenous, isAsk, OWNER_SHAPES } from "./asks"
import { LAPSE, blames, grades, noteRefold, openPersonWaits, outcomeSchemaOf, personWait, promises, standing, useGrades } from "./fold"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, CREDITS, DESCRIBED, DETECTOR, FAILURE, FAILURE_RULE, INFRA_WINDOW, GAP, HOLD_FACT, HOP, OPERATOR, OUTCOME, OWNER, PERSON, PRIOR, REPOSITORY, REQUIRES, RHYTHM, SELECTION, SHAPE_SCHEMA, SHAPE_DESCRIPTION, WALK, PERSON_WAIT, ASK_STATE, WAIT_BOUND,
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
  calls?: string[] | "all"
  latest_by?: string
  // The calls made for one root (with calls: "all"), or one call by its id; output false leaves each call's output out.
  root?: string
  call_id?: string
  output?: boolean
  head?: boolean
  // Only rows that hold this field (any value): after latest_by, so a thing whose latest row dropped the field shows nothing.
  has?: string
  // Rows as written: no hold shown as its fact (factsOn). For a reader that writes rows back (pull-sync's gap upkeep).
  stored?: boolean
  // The newest N of the rows the read matches, in seq order: a bound on what one read can serialize.
  limit?: number
  // Fields of rows the reader wrote itself that it does not read back, by shape: left out of its episodes answer (omitting).
  omit?: Record<string, string[]>
  // "beside": the walk's newest arm after the open roots too, on the episodes read (episodes).
  arm?: string
}

const MINE = new Set([SELECTION, HOP, FAILURE])
const FILE = join(DATA_DIR, "rows")

// A fresh volume has no data directory of records' own: make it before the file, or the first boot exits ENOENT on every
// start and crash-loops (install acceptance: records never served on a new install). Only that directory: its parent is
// the fleet's (the entrypoint makes it), and a missing parent means the volume is not what records expects, so it exits
// naming it rather than make a store somewhere a recreate would lose. An existing directory is left as it is.
if (!existsSync(dirname(DATA_DIR))) {
  console.error(`[records] the data directory's parent ${dirname(DATA_DIR)} does not exist: not making a store outside the fleet's volume`)
  process.exit(1)
}
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { mode: 0o700 })
appendFileSync(FILE, "")
// read by lines (rows-file.ts): the file is past what one string can hold
export const rows: Row[] = await rowsIn<Row>(Bun.file(FILE).stream())
let seq = rows.length
// The self-check's state, read once from the rows as loaded: what it finds there was written when those rows were.
const selfChecks = checker(VESSEL_ID)
for (const r of rows) selfChecks.see(r)
let wakers: Array<() => void> = []

// A VIEW NEVER BECOMES DATA: a row carrying the mark records puts on a fact it showed in place of a hold (read_as_fact,
// factsOn) is a read written back, and is refused, so a writer that read without `stored` fails loud instead of storing
// the owner's reading as if it had observed it.
export const READ_AS_FACT = "read_as_fact"
// The same for a row records showed thinner than written (fields_omitted, omitting): written back, it would store the
// reader's thinned copy as if it were the row.
export const FIELDS_OMITTED = "fields_omitted"
// WHOSE ROW, BY USER: user_id is records' own field, as writer is: the user identity answered for a person's key at the
// write (index.ts), on a person's row only, and absent when identity named none (never the keyId in its place). A value
// a sender put in its row is never stored as given: it is dropped from every row, whoever wrote it.
export const USER_ID = "user_id"
export const write = (body: Record<string, unknown>, writer: string, role: string, user?: string): { status: number; body: unknown } => {
  const meta = typeof body.meta === "object" && body.meta !== null ? body.meta as Record<string, unknown> : {}
  if (READ_AS_FACT in body || READ_AS_FACT in meta) {
    return { status: 400, body: { failure: { status: 400, body: `${READ_AS_FACT}: a row records showed as read (a hold shown as its fact) is not written back; read with stored: true` } } }
  }
  if (FIELDS_OMITTED in body || FIELDS_OMITTED in meta) {
    return { status: 400, body: { failure: { status: 400, body: `${FIELDS_OMITTED}: a row records showed without some of its fields is not written back; read it by id for the whole row` } } }
  }
  if (String(body.shape) === PERSON_WAIT) {
    return { status: 400, body: { failure: { status: 400, body: `${PERSON_WAIT}: derived on read from the walk's failures, never written` } } }
  }
  if (String(body.shape) === ASK_STATE) {
    return { status: 400, body: { failure: { status: 400, body: `${ASK_STATE}: derived on read from the rows on each open ask, never written` } } }
  }
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
  const { [USER_ID]: _given, ...sent } = body
  const stamp = role === PERSON && user !== undefined ? { [USER_ID]: user } : {}
  const unsigned = { input_refs: [], ...sent, ...deadline, ...blame, seq, t, writer, role, ...stamp }
  const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(unsigned)).digest("hex")
  const row: Row = { ...unsigned, shape: String(body.shape), id }
  appendFileSync(FILE, `${JSON.stringify(row)}\n`)
  rows.push(row)
  const found = selfChecks.see(row)
  const woken = wakers
  wakers = []
  for (const f of woken) {
    f()
  }
  // What the self-check found at this row is written after it, as records' own detector rows (self-check.ts).
  for (const g of selfChecks.gapsOf(found)) write(g, VESSEL_ID, DETECTOR)
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
  if (q.has !== undefined) {
    const f = String(q.has)
    out = out.filter((r) => r[f] !== undefined && r[f] !== null)
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

// A request is closed when a grade that stands says how it ended (fold.ts standing, the fold's own predicate: of a
// writer's grades of one answer only the latest stands): DONE by a
// person's verdict at r 1 on an answer to it that claims the result (not one that promises the next act: fold.ts
// promises); FAILED by a lapse (a counted r 0 on its deadline row). A described
// outcome at r 1 is the walk grading its own answer and does not close a request: an independent grade (by information,
// not only by a person) would, and is not built yet. "Answers it" is provenance: the judged row cites the request in
// its input_refs.
const closed = (byRule = true): Set<string> => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = new Set<string>()
  // byRule false: the closes a writer's grade made, without the fold's derived lapses (lapsed() reads that, below)
  for (const g of standing(rows, seq, seq).filter((k) => byRule || k.by !== LAPSE)) {
    const ends = (g.r === 1 && g.by === PERSON && !promises(rows, byId.get(g.judged))) || (g.r === 0 && g.deadline)
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
// A HOLD THE OWNER READS AS A FACT (hold_fact rows; the USER: "Read as facts"; 11-15 "fact + debit, NO hold"). A hold
// whose reason starts a hold_fact row's reason_prefix says only what its fact says (pull-sync's failing-test generator:
// no source frame names the edit site, which the walk can find with tools it has): the gap is work, and a producer is
// shown the fact in place of the hold (projected). No stored row is rewritten. Any other hold (a person's, any later
// kind) is honoured as before, and with no such row every hold is.
const holdOf = (r: Row): { hold: boolean; reason: string } => {
  const m = (r.meta ?? {}) as { operator_hold?: unknown; operator_hold_reason?: unknown }
  return { hold: r.operator_hold === true || m.operator_hold === true, reason: String(r.operator_hold_reason ?? m.operator_hold_reason ?? "") }
}
type Fact = { id: string; prefix: string; fact: Record<string, unknown> }
const holdFacts = (): Fact[] => {
  const latest = new Map<string, Row>()
  for (const r of rows.filter((x) => x.shape === HOLD_FACT && x.role === OWNER).sort((a, b) => a.seq - b.seq)) {
    if (typeof r.reason_prefix === "string" && r.reason_prefix !== "") latest.set(r.reason_prefix, r)
  }
  return [...latest.values()]
    .filter((r) => r.retired !== true && typeof r.fact === "object" && r.fact !== null && !Array.isArray(r.fact))
    .map((r) => ({ id: r.id, prefix: String(r.reason_prefix), fact: r.fact as Record<string, unknown> }))
}
// The fact a gap row's hold reads as, or undefined when it holds nothing the owner reads as one.
const factRowOf = (r: Row, facts: Fact[]): Fact | undefined => {
  const h = holdOf(r)
  return h.hold ? facts.find((f) => h.reason.startsWith(f.prefix)) : undefined
}
const factOf = (r: Row, facts: Fact[]): Record<string, unknown> | undefined => factRowOf(r, facts)?.fact

const openGaps = (from: Row[]): Row[] => {
  const latest = new Map<string, Row>()
  for (const r of from.filter((x) => x.shape === GAP && x.role === DETECTOR && x.gap_id !== undefined)) latest.set(String(r.gap_id), r)
  // A gap held by a person (operator_hold on its latest row, kept in its meta by the detector; not the owner's fact, above) is no one's work until
  // the hold lifts: it is not a root.
  const facts = holdFacts()
  const held = (r: Row): boolean => holdOf(r).hold && factOf(r, facts) === undefined
  // A gap a person judged to have a wrong test (check_runnable false on its latest row, written by the detector's
  // release from that person's r 0) is no one's work here either: a change must not edit the check that verifies it, so
  // nothing the walk could do on it is allowed, not a clone, an edit, a commit or a landing in a clone made before. The
  // test is fixed by a reviewed commit to the vessel, and the detector closes the gap once it passes. A later r 1
  // clears the mark, and the gap is a root again.
  const notRunnable = (r: Row): boolean => r.check_runnable === false || (r.meta as { check_runnable?: unknown } | undefined)?.check_runnable === false
  // A gap its detector says no change here could fix (walkable false: what failed is a vessel the walk calls, an outage
  // or a timeout) is shown, not worked: not a root, and so never a producer's work or debit (the USER: infra gaps are
  // gaps, marked, not offered to the walk). Read from the detector's own field, never from what kind of gap it is.
  const notWalkable = (r: Row): boolean => r.walkable === false
  return [...latest.values()].filter((r) => r.status === "open" && !held(r) && !notRunnable(r) && !notWalkable(r))
}

// The asks the owner declares (asks.ts declaredAsks), over the whole store.
const askShapes = (): Set<string> | undefined => declaredAsks(rows)

// The walk's newest arm: the owner's row naming this walker.
const armOf = (w: string): Row[] =>
  rows.filter((r) => r.shape === ARM).filter((r) => r.role === OWNER).filter((r) => String(r.vessel_id) === w).slice(-1)

const openRoots = (w: string): Row[] => {
  const done = closed()
  const declared = askShapes()
  const open = [...rows.filter((r) => isAsk(r, declared)).filter((r) => !done.has(r.id)), ...openGaps(rows)]
    .sort((a, b) => a.seq - b.seq)
  if (open.length > 0) return open
  return armOf(w)
}

// The rows descended from one root: it, the walk's selections whose pool held it, their hops and failures, the
// described rows those selections made, and the rows the walk recorded from a tool's answer for them (a gitDiff).
// A gap's root is its gap_id, not one row of it: a detector that writes the gap again while it stays open (a field
// carried, a summary changed, a hold lifted) speaks for the same work. Its episode is every detector row of that gap_id
// since its last closed row, and the work that cited any of them, so writing the row again never restarts the walk on
// it. The latest row is the root and says what the gap is now (status, repo, hold). A gap closed and opened again
// starts a new episode.
// Every gap root's detector rows, by its gap_id, found in one pass over the store for all the roots of a read.
const isGapRoot = (root: Row): boolean => root.shape === GAP && root.role === DETECTOR && root.gap_id !== undefined
const gapRowsOf = (roots: Row[]): Map<string, Row[]> => {
  const want = new Set(roots.filter(isGapRoot).map((root) => String(root.gap_id)))
  const out = new Map<string, Row[]>()
  for (const r of rows) {
    if (r.shape !== GAP || r.role !== DETECTOR) continue
    const k = String(r.gap_id)
    if (!want.has(k)) continue
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}
const episodeOf = (root: Row, gaps: Map<string, Row[]>): Row[] => {
  if (!isGapRoot(root)) return [root]
  const same = (gaps.get(String(root.gap_id)) ?? []).filter((r) => r.seq <= root.seq)
    .sort((a, b) => a.seq - b.seq)
  const since = same.filter((r) => r.status !== "open").at(-1)?.seq ?? 0
  return same.filter((r) => r.seq > since)
}

// Which of the given rows each of the walk's selections cites, found in one pass over the selections' lists per read.
// The given rows are every open root's own (its ask, or its gap's rows since the last close), a handful. A selection
// written before the walk kept only its root carries its whole pool in its lists, so scanning them again for each
// root made each read cost the number of roots times every list's length.
const citedBy = (w: string, ids: Set<string>): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.shape !== SELECTION || r.writer !== w) continue
    let got: Set<string> | undefined
    for (const list of [r.pool_refs, r.input_refs]) {
      if (!Array.isArray(list)) continue
      for (const id of list) {
        const k = String(id)
        if (ids.has(k)) (got ??= new Set()).add(k)
      }
    }
    if (got) out.set(r.id, got)
  }
  return out
}

const into = <K, V>(m: Map<K, V[]>, k: K, v: V): void => {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}
// The rows descended from each of the given roots, in the roots' order, each root's in store order. Found for all the
// roots at once in a fixed number of passes over the store (the gap rows, the selections, the rows they hold, the
// answer), not seven per root: with 41 roots on a 74k-row store, one pass set per root took 8-14 s of every read.
// Each root's rows are what they were found per root: its episode, the walk's selections citing any of it, their hops
// and failures, the described rows they made, the walk's other rows recorded under them, the walk's failures citing
// the root itself, and a person's row citing any of those (one step: a person's row citing only another person's
// row that joined is not the root's).
const rootRows = (w: string, roots: Row[]): Row[][] => {
  const gaps = gapRowsOf(roots)
  const ofRoot = new Map<string, number[]>()
  const keep = roots.map((root, i) => {
    const ids = new Set<string>()
    for (const r of episodeOf(root, gaps)) {
      ids.add(r.id)
      into(ofRoot, r.id, i)
    }
    return ids
  })
  // The roots each of the walk's selections works: those whose episode holds a row it cites.
  const bySel = new Map<string, Set<number>>()
  for (const [sel, got] of citedBy(w, new Set(ofRoot.keys()))) {
    const at = new Set<number>()
    for (const id of got) for (const i of ofRoot.get(id) ?? []) at.add(i)
    if (at.size > 0) bySel.set(sel, at)
  }
  const people: Row[] = []
  for (const r of rows) {
    const under = (sel: string): void => {
      for (const i of bySel.get(sel) ?? []) keep[i]!.add(r.id)
    }
    if (MINE.has(r.shape) && r.writer === w) under(r.shape === SELECTION ? r.id : String(r.selection_ref))
    if (r.role === DESCRIBED && r.shape !== ACTIVITY_TEMPLATE) under(String(r.selection_ref))
    if (r.role === WALK && r.writer === w && !MINE.has(r.shape)) under(String(r.selection_ref))
    // A failure this walk wrote about the root itself, not about a move (no selection_ref: a root that sat with no move
    // is said so, citing the root): the root's too. Without it the root's newest row never moved past it, so the walk
    // said it again every tick, and its producers were never shown it.
    if (r.shape === FAILURE && r.role === WALK && r.writer === w && r.selection_ref === undefined) {
      for (const id of [r.input_refs].flat()) for (const i of ofRoot.get(String(id)) ?? []) keep[i]!.add(r.id)
    }
    if (r.role === PERSON) people.push(r)
  }
  // A person's row about anything of a root (a mark on its diff, a grade of its answer, a word on its ask) is the
  // root's too: it cites one of the rows above. Without it the walk never saw the person's verdict a call waited on (a
  // landing waiting for a person's mark on its diff), and producers were never shown it. Decided against the rows above
  // only, and added after, so a person's row citing another person's row is not the root's for that alone.
  const held = new Map<string, number[]>()
  keep.forEach((ids, i) => { for (const id of ids) into(held, id, i) })
  const joined: Array<[number, string]> = []
  for (const p of people) {
    const at = new Set<number>()
    for (const id of [p.input_refs].flat()) for (const i of held.get(String(id)) ?? []) at.add(i)
    for (const i of at) joined.push([i, p.id])
  }
  for (const [i, id] of joined) keep[i]!.add(id)
  // A detector's row that a shape is served again ({served: <shape>}) is a root's when the root holds a failure of this
  // walk's that named that shape unserved before it: the recovery of what held the root's moves, placed where it held
  // them, and nowhere else (a root none of whose calls went unserved there has learned nothing from it).
  const recovered = rows.filter((r) => r.role === DETECTOR && typeof r.served === "string" && r.served !== "")
  if (recovered.length > 0) {
    const ids = new Map(rows.map((r) => [r.id, r]))
    keep.forEach((own, i) => {
      const first = new Map<string, number>()
      for (const id of own) {
        const r = ids.get(id)
        if (r?.shape !== FAILURE || r.writer !== w || typeof r.unserved !== "string") continue
        first.set(r.unserved, Math.min(first.get(r.unserved) ?? Infinity, r.seq))
      }
      for (const r of recovered) if (r.seq > (first.get(String(r.served)) ?? Infinity)) keep[i]!.add(r.id)
    })
  }
  const answer = new Map<string, number[]>()
  keep.forEach((ids, i) => { for (const id of ids) into(answer, id, i) })
  const out = roots.map((): Row[] => [])
  for (const r of rows) for (const i of answer.get(r.id) ?? []) out[i]!.push(r)
  return out
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
  // Which selections worked each request a person graded done, found in one pass over the selections' lists (a
  // selection written before the walk kept only its root carries its whole pool there), not once per template.
  const byRoot = new Map<string, Set<string>>()
  for (const s of sels) {
    for (const id of [s.pool_refs].flat()) {
      const k = String(id)
      if (!done.has(k)) continue
      const set = byRoot.get(k)
      if (set) set.add(s.id)
      else byRoot.set(k, new Set([s.id]))
    }
  }
  // The walk's ended calls, in store order, found once per read, not once per template's root: each root keeps those of
  // its selections from this list. A pass over the whole store per root grew with templates × store size.
  const ended = rows.filter((r) => r.shape === HOP && r.writer === w && r.phase === "ended" && (r.kind === "call" || r.kind === "run"))
  const calledIn = (root: string): string[] => {
    const held = byRoot.get(root) ?? new Set<string>()
    return ended
      .filter((r) => held.has(String(r.selection_ref)))
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

// What every root's work shares: the owner's configuration (below), the templates the walk earned, and the templates a
// standing rhythm names (the walk runs those only when their rhythm is due).
const SHARED_UNTIL_DECLARED = new Set([CHANNEL, SHAPE_SCHEMA, REQUIRES, REPOSITORY, RHYTHM])
const shared = (w: string): Row[] => {
  const allSels = new Set(rows.filter((r) => r.shape === SELECTION).filter((r) => r.writer === w).map((r) => r.id))
  const ok = earned(w)
  const scheduled = rhythmTemplates()
  // The owner's configuration: once asks are declared, every owner row that is not one (whatever its shape: a new setting
  // the walk reads reaches it with no change here); until then, the listed shapes, as before.
  const declared = askShapes()
  const config = (r: Row): boolean => r.role === OWNER && r.shape !== ACTIVITY_TEMPLATE &&
    (declared === undefined ? SHARED_UNTIL_DECLARED.has(r.shape) : !declared.has(r.shape))
  return rows.filter((r) =>
    config(r) ||
    (r.shape === ACTIVITY_TEMPLATE && (r.role === DESCRIBED || r.role === OWNER) && scheduled.has(r.id)) ||
    (r.shape === ACTIVITY_TEMPLATE && r.role === DESCRIBED && allSels.has(String(r.selection_ref)) && ok(r)))
}

// The templates the owner's standing rhythms name: the latest rhythm row per template, unless it says retired.
const rhythmTemplates = (): Set<string> => {
  const latest = new Map<string, Row>()
  for (const r of rows.filter((x) => x.shape === RHYTHM && x.role === OWNER).sort((a, b) => a.seq - b.seq)) latest.set(String(r.template), r)
  return new Set([...latest.values()].filter((r) => r.retired !== true).map((r) => String(r.template)))
}

export const episode = (w: string): Row[] => {
  const [root] = openRoots(w)
  const keep = new Set([...(root ? rootRows(w, [root])[0]! : []), ...shared(w)].map((r) => r.id))
  return rows.filter((r) => keep.has(r.id))
}

// Every open root with its own rows, oldest first, and the rows they share listed once: which request to work is the
// walk's selection to make, not this store's. With none open, the walk's newest arm, as it idles.
// Whether anyone awaits an answer on a root: a person's or the owner's request does, and so does a gap a detector opened
// (it awaits the change its check passes on); only the walk's arm does not, so only idling is waited through unbounded.
// A wait is answered by the next person or owner row, which no one writes for a detector's gap: one taken there would
// hold every root until an unrelated row came. Stated here, where roots are made, so the walk reads it and never needs
// to know a shape's name.
// And a root's deadlines (dues): the `at` of every deadline row among its rows, in seq order, as the fold judges them (a
// producer's row with within_ms and the at records stamped, citing an ask). Every one counts ("Later deadlines close
// it"), so the walk bounds a wait by the next one ahead and reads one passed from here, rather than keep its own copy
// of which deadline is the request's: two copies of one rule drift.
// Asked for (beside), the walk's newest arm comes after the open roots too, when any is open: a rhythm the owner
// schedules is counted against the store's head, never against idling, so handed only when nothing was open its runs
// never came while a request or gap stayed open. Its rows (its last run among them) come with it, since a rhythm counts
// from its last run. The walk offers the arm beside other roots only what its rhythms made due. Only a reader that asks
// is given it, so every other reader's answer stays as it was; and the other readers of the open roots (a wait's shown
// rows, which calls are open work) are unchanged: the arm beside them is no work of a root.
export const episodes = (w: string, beside = false): { shared: Row[]; roots: Array<{ root: Row; rows: Row[]; awaits: boolean; dues: number[] }> } => {
  const open = openRoots(w)
  const roots = !beside || open.some((r) => r.shape === ARM) ? open : [...open, ...armOf(w)]
  const found = rootRows(w, roots)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const declared = askShapes()
  const dues = (rs: Row[]): number[] => [...rs].sort((x, y) => x.seq - y.seq)
    .filter((r) => deadlineAsks(r, (id) => byId.get(id), declared).length > 0)
    .map((r) => Number(r.at))
  return { shared: shared(w), roots: roots.map((root, i) => ({ root, rows: found[i]!, awaits: root.shape !== ARM, dues: dues(found[i]!) })) }
}

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

// The owner's bound on a wait (WAIT_BOUND's within_ms, the latest row), read at each wait. With no row a wait is held
// until a row answers it, said once.
let saidUnbounded = false
const waitBound = (): number | undefined => {
  const latest = rows.filter((r) => r.shape === WAIT_BOUND && r.role === OWNER).at(-1)
  const ms = latest?.within_ms
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms
  if (!saidUnbounded) { saidUnbounded = true; console.log("[records] no wait_bound row of the owner's: a wait with nothing ahead is held until a row answers it") }
  return undefined
}

// A wait answers the first row of the shapes asked for (or any exogenous row, or a detector's gap row, opening or closing
// one: either changes what the walk has to work) after afterSeq. So does a detector's row the waiting walk (episode, the
// walk's id) is shown in one of its open roots: an observation placed where the walk's work is (rootRows), which is how
// a shape served again ends a wait its going unserved began. Given a deadline (the caller's `until`, ms since the
// epoch, taken from its own rows), it answers null at that time: "nothing yet". The owner's bound (waitBound) ends it
// sooner when it comes first, so no wait is held for ever on an outside change no row records.
export const wait = (shapes: string[], afterSeq: number, deadline?: number, episode?: string): Promise<Row | null> => {
  const bound = waitBound()
  return until(() => {
    const after = rows.filter((r) => r.seq > afterSeq)
    const want = new Set(shapes)
    const gaps = after.filter((r) => r.shape === GAP && r.role === DETECTOR)
    const seen = after.filter((r) => r.role === DETECTOR && r.shape !== GAP)
    const shown = episode === undefined || seen.length === 0 ? new Set<string>() : new Set(rootRows(episode, openRoots(episode)).flat().map((r) => r.id))
    const hits = new Set([...after.filter((r) => want.has(r.shape)), ...exogenous(after), ...gaps, ...seen.filter((r) => shown.has(r.id))].map((r) => r.id))
    return after.filter((r) => hits.has(r.id))
  }, bound === undefined ? deadline : Math.min(deadline ?? Infinity, Date.now() + bound))
}

/** A record_wait pointer as the walk sends it: the shapes, the seq it waits after, its deadline and the walk it is. */
export const waitAsked = (p: { shapes?: unknown; after_seq?: unknown; until?: unknown; episode?: unknown }): Promise<Row | null> =>
  wait(Array.isArray(p.shapes) ? p.shapes.map(String) : [], Number(p.after_seq), p.until === undefined ? undefined : Number(p.until),
    p.episode === undefined ? undefined : String(p.episode))

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
  const declared = askShapes()
  const asks = (r: Row): string[] => [r.input_refs].flat().map(String).filter((id) => isAsk(byId.get(id), declared))
  // what a written grade judged or closed: the fold's own derived lapses (fold.ts LAPSE) are what this lists, by the wall
  // clock, so they neither hide it nor close the ask here
  // and a grade a model wrote of a deadline, which counts for nothing (fold.ts by_rule) but was written: listed again, the
  // grader would be shown it, and write it, every time
  const judged = new Set(grades(rows, seq, seq).filter((k) => k.by !== LAPSE && (k.ok || k.refused === "by_rule")).map((k) => k.judged))
  const done = closed(false)
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
  return callsOf(w, (h, live) => want.has(String(h.pointer_type)) || live(h))
}

// The calls a walker made that `keep` takes, each as walkCalls answers it. keep is given the started hop and whether it
// is still in flight.
const callsOf = (w: string, keep: (h: Row, live: (h: Row) => boolean, sel: Row | undefined) => boolean): Call[] => {
  const open = new Set(openRoots(w).map((r) => r.id))
  const mine = rows.filter((r) => MINE.has(r.shape) && r.writer === w)
  const sels = new Map(mine.filter((r) => r.shape === SELECTION).map((s) => [s.id, s]))
  const ended = new Map(mine.filter((r) => r.shape === HOP && r.phase === "ended").map((r) => [String(r.call_id), r]))
  const failed = new Set(mine.filter((r) => r.shape === FAILURE).map((r) => String(r.call_id)))
  const newest = mine.filter((r) => r.shape === SELECTION).reduce<Row | undefined>((a, r) => (a === undefined || r.seq > a.seq ? r : a), undefined)
  const settled = (id: string) => ended.has(id) || failed.has(id)
  const live = (h: Row) => !settled(String(h.call_id)) && (String(h.selection_ref) === newest?.id || !sels.has(String(h.selection_ref)))
  return mine.filter((r) => r.shape === HOP && r.phase === "started" && keep(r, live, sels.get(String(r.selection_ref)))).map((h) => {
    const id = String(h.call_id)
    const root = String(sels.get(String(h.selection_ref))?.root ?? "")
    const e = ended.get(id)
    return {
      call_id: id, type: String(h.pointer_type), selection_ref: String(h.selection_ref), root, open: open.has(root),
      state: e ? "ended" : failed.has(id) ? "failed" : live(h) ? "started" : "abandoned", seq: h.seq, t: h.t, ...(e ? { output: e.output } : {}),
    }
  })
}

// The calls made for one root, oldest first: a person's view of what the walk did with their ask reads this, one read per
// ask, naming no walker and no call shape. The walker is whoever wrote a selection for the root; every call its
// selections for the root started is answered, whatever its shape. With output false each call's output (an ended
// call's answer, at most 16 KiB as the walk keeps it) is left out, so a view that draws only the steps reads rows, not
// their answers; a step's answer is then read by its call id.
export const rootCalls = (root: string, output = true): Call[] => {
  const walkers = new Set(rows.filter((r) => r.shape === SELECTION && String(r.root) === root).map((r) => String(r.writer)))
  const all = [...walkers].flatMap((w) => callsOf(w, (_h, _live, sel) => String(sel?.root) === root))
  return all.sort((a, b) => a.seq - b.seq).map((c) => (output ? c : (({ output: _o, ...rest }) => rest)(c) as Call))
}

// WHERE EACH OPEN ASK STANDS NOW: one derived row per open ask (asks.ts isAsk, as the owner declares asks; not closed by
// a person's Right on a result or a lapse, as closed() reads it), oldest first, named for its ask (ask_state:<ask id>, the
// same across reads) and naming who asked (asker, asker_role; asker_user, the user records stamped on a person's ask, null
// when it has none: never the key in its place), so a page can show a person their own asks. Each state
// that holds is its own field, and a field is absent when its state does not; when several hold, all are carried, and
// which matters more is for whoever presents them, not for records:
//   waiting_pick:   no selection names the ask as its root yet (true);
//   working:        each call made for the ask that is still in flight, as callsOf reads one (started, neither ended
//                   nor failed, under its walker's newest selection): its pointer_type and call_id;
//   answered:       the newest answer to it: a row the walk's producer made, of a shape the owner's outcome schema names
//                   as evidence (what a grade judges as the answer), whose own root is the ask; its id;
//   waiting_on_you: the person_wait on its root now (openPersonWaits): that row's id, the failure it cites, and the tree,
//                   repo and time it states.
// A gap is no ask (no person asked it), so it has no ask_state. Facts only: read from rows present, nothing is written,
// and no grade or credit reads it. Records refuses a stored one. Its seq and t are the newest stored row its facts are
// derived from (below); ask_seq and ask_t are the ask's own, and rows sort by them, oldest ask first.
const deriveAskStates = (): Row[] => {
  const declared = askShapes()
  const done = closed()
  const asks = rows.filter((r) => isAsk(r, declared) && !done.has(r.id))
  if (asks.length === 0) return []
  const open = new Set(asks.map((r) => r.id))
  // The selections made for an open ask: whether it was picked, and whose calls may be in flight for it.
  const sels = rows.filter((r) => r.shape === SELECTION && open.has(String(r.root)))
  const picked = new Set(sels.map((r) => String(r.root)))
  const working = new Map<string, Array<{ pointer_type: string; call_id: string }>>()
  for (const w of new Set(sels.map((r) => String(r.writer)))) {
    for (const c of callsOf(w, () => true)) if (c.state === "started") into(working, c.root, { pointer_type: c.type, call_id: c.call_id })
  }
  const evidence = new Set([outcomeSchemaOf(rows)?.evidence ?? []].flat()
    .map((e) => typeof e === "object" && e !== null ? (e as { shape?: unknown }).shape : undefined)
    .filter((x): x is string => typeof x === "string"))
  // An answer's own root is the root it states, else the root of the selection it was made under; with neither it
  // answers no ask. The asks it cites do not decide it: an answer made for one ask may cite another as context, and
  // is no answer to that one.
  const rooted = (x: unknown): x is string => typeof x === "string" && x !== ""
  const selById = new Map(rows.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const ownRoot = (r: Row): string | undefined => rooted(r.root) ? r.root : [selById.get(String(r.selection_ref))?.root].find(rooted)
  const answered = new Map<string, string>()
  for (const r of rows) {
    if (r.role !== DESCRIBED || !evidence.has(r.shape)) continue
    const own = ownRoot(r)
    if (own !== undefined) answered.set(own, r.id)
  }
  const waits = new Map(openPersonWaits(rows).map((p) => [String(p.root), p]))
  // THE NEWEST ROW EACH ASK'S FACTS ARE DERIVED FROM, so a reader learns a row is news from its seq and t, never by
  // working newness out itself. A state ending is news too, so the rows that end one count. The rows, per ask:
  //   the ask itself;
  //   each selection whose root is the ask;
  //   each call started under such a selection: its started hop, and its ended hop or failure when it has one; and when
  //     it has neither and its walker made a newer selection (callsOf: only a call under the walker's newest selection is
  //     in flight), the first such selection, which is what ended it; never a newer selection that ended no call of it;
  //   each answer whose own root is the ask (the newest answer is among them);
  //   the root's latest wait on a person (a walk failure saying waits_for person, its selection's root the ask), and the
  //     first person row about the root after it (personWait's reading), which ended it.
  const news = new Map<string, Row>()
  const note = (root: string, r: Row | undefined): void => {
    if (r === undefined || !open.has(root)) return
    const n = news.get(root)
    if (n === undefined || r.seq > n.seq) news.set(root, r)
  }
  for (const a of asks) note(a.id, a)
  for (const sel of sels) note(String(sel.root), sel)
  for (const w of new Set(sels.map((r) => String(r.writer)))) {
    const mine = rows.filter((r) => MINE.has(r.shape) && r.writer === w)
    // The walker's selections in store order, which is seq order (rows are appended with a rising seq); each one's
    // next is the first newer selection, found once here rather than searched for per call.
    const wsels = mine.filter((r) => r.shape === SELECTION)
    const ownSels = new Map(wsels.map((r) => [r.id, r]))
    const nextSel = new Map(wsels.map((r, i) => [r.id, wsels[i + 1]]))
    const firstBy = (shape: string, phase?: string): Map<string, Row> => {
      const m = new Map<string, Row>()
      for (const r of mine) if (r.shape === shape && (phase === undefined || r.phase === phase) && !m.has(String(r.call_id))) m.set(String(r.call_id), r)
      return m
    }
    const ended = firstBy(HOP, "ended")
    const failed = firstBy(FAILURE)
    for (const h of mine.filter((r) => r.shape === HOP && r.phase === "started")) {
      const sel = ownSels.get(String(h.selection_ref))
      // a call for a root that is no open ask is news for no row: skipped before any lookup
      if (sel === undefined || !open.has(String(sel.root))) continue
      const root = String(sel.root)
      const id = String(h.call_id)
      note(root, h)
      note(root, ended.get(id))
      note(root, failed.get(id))
      if (!ended.has(id) && !failed.has(id)) note(root, nextSel.get(sel.id))
    }
  }
  for (const r of rows) {
    if (r.role !== DESCRIBED || !evidence.has(r.shape)) continue
    const own = ownRoot(r)
    if (own !== undefined) note(own, r)
  }
  const byId = new Map(rows.map((r) => [r.id, r]))
  const { persons, about } = personWait(rows, byId)
  const lastWait = new Map<string, Row>()
  for (const f of rows) {
    if (f.shape !== FAILURE || f.role !== WALK || f.waits_for !== "person") continue
    const root = String(byId.get(String(f.selection_ref))?.root)
    if (open.has(root)) lastWait.set(root, f)
  }
  for (const [root, f] of lastWait) {
    note(root, f)
    note(root, persons.find((x) => x.seq > f.seq && about(x, root)))
  }
  return asks.map((a) => {
    const p = waits.get(a.id)
    const calls = working.get(a.id)
    const answer = answered.get(a.id)
    return {
      shape: ASK_STATE, id: `${ASK_STATE}:${a.id}`, writer: "records", role: "records", root: a.id, asker: a.writer, asker_role: a.role,
      asker_user: a.role === PERSON && typeof a[USER_ID] === "string" ? a[USER_ID] : null,
      seq: news.get(a.id)!.seq, t: news.get(a.id)!.t, ask_seq: a.seq, ask_t: a.t, input_refs: [a.id],
      ...(picked.has(a.id) ? {} : { waiting_pick: true }),
      ...(calls !== undefined ? { working: calls } : {}),
      ...(answer !== undefined ? { answered: answer } : {}),
      ...(p !== undefined ? { waiting_on_you: { person_wait: p.id, failure: [p.input_refs].flat()[0], tree: p.tree, repo: p.repo, t: p.t } } : {}),
    } as Row
  }).sort((x, y) => Number(x.ask_seq) - Number(y.ask_seq))
}

// AN ASK_STATE READ IS DERIVED ONCE PER STORE STATE. What it reads is the rows and the store's seq only: closed() folds
// grades at seq, a lapse is judged by the newest row's time (the store's own clock, never the process's), and callsOf,
// openPersonWaits and the declarations read rows. The rows are append-only, so the answer holds while the row count,
// the seq and the newest row are unchanged; a read in between is served from the kept answer, and each derivation is
// said as a refold (what a read cost). Every read gets its own copy: nothing a caller does to it reaches the kept one.
let askStatesKept: { key: string; states: Row[] } | undefined
export const openAskStates = (): Row[] => {
  const key = `${rows.length}|${seq}|${rows[rows.length - 1]?.id ?? ""}`
  if (askStatesKept?.key !== key) {
    const t0 = performance.now()
    askStatesKept = { key, states: deriveAskStates() }
    noteRefold({ fold: ASK_STATE, rows: rows.length, ms: Math.round(performance.now() - t0) })
  }
  return structuredClone(askStatesKept.states)
}

// One call by its id, as walkCalls answers it, with its output; [] when no call has that id.
export const oneCall = (callId: string): Call[] => {
  const started = rows.find((r) => r.shape === HOP && r.phase === "started" && String(r.call_id) === callId)
  return started ? callsOf(String(started.writer), (h) => String(h.call_id) === callId) : []
}

// What an episode answer carries of the walk's selections. A selection used to keep every id of the move's pool in
// pool_refs and again in input_refs, so on a long-worked root each row held the whole episode, and the answer grew
// with the square of it. The walk reads those lists back for one thing only: to tell whether a produce was already
// refused over the same rows, from a selection that a schema refusal cites. So a selection is answered without them,
// unless such a refusal in the same answer cites it. Each one left out says so (refs_omitted: how many ids, and an
// empty input_refs), so a reader can tell a list left out from an empty one. Only selections are projected; the
// stored rows are unchanged, and every reader inside records (the fold, closing, templates) reads them whole.
// A HOLD THE OWNER READS AS A FACT is shown as its fact on EVERY read that returns rows, not only the walk's episodes
// (agf_98l3jzumfcrq: a producer reading a gap by id got the raw hold, and answered that the gap waits for its release).
// The stored rows are unchanged.
export const factsOn = (rs: Row[]): Row[] => {
  if (!rs.some((r) => r.shape === GAP)) return rs
  const facts = holdFacts()
  return rs.map((r) => {
    const f = r.shape === GAP ? factRowOf(r, facts) : undefined
    if (f === undefined) return r
    // The fact goes where the hold was (the row's top level, its meta, or both), marked as records' reading (never
    // written back: write() refuses the mark); the row's own fields win over the fact's.
    const said = { ...f.fact, [READ_AS_FACT]: { hold_fact: f.id } }
    const top = r.operator_hold === true
    const m = typeof r.meta === "object" && r.meta !== null ? r.meta as Record<string, unknown> : undefined
    const { operator_hold: _h, operator_hold_reason: _hr, ...rest } = r
    const meta = m === undefined ? undefined : (({ operator_hold: _mh, operator_hold_reason: _mhr, ...k }) => m.operator_hold === true ? { ...said, ...k } : k)(m)
    return { ...(top ? said : {}), ...rest, ...(meta !== undefined ? { meta } : {}) } as Row
  })
}
export const projected = (rs: Row[]): Row[] => {
  const refusedSel = new Set(rs.filter((r) => r.shape === FAILURE && r.refused === "schema").map((r) => String(r.selection_ref)))
  return factsOn(rs).map((r) => {
    if (r.shape !== SELECTION || refusedSel.has(r.id)) return r
    const { pool_refs, input_refs, ...rest } = r
    return { ...rest, input_refs: [], refs_omitted: [pool_refs ?? []].flat().length + [input_refs ?? []].flat().length } as Row
  })
}

// What a reader does not need of the rows it wrote itself, left out of its episodes answer (omit: {shape: [field, ...]}):
// the walk's selections keep, for other readers, what it never reads back (every candidate and posterior of the draw),
// and served whole each tick they were most of the answer's bytes. The reader names the fields, so records keeps no
// list of its own. Only the reader's own rows: no reader is shown another writer's row thinner than written. Applied
// last, on copies, so nothing records computes (standing, refusals, facts) reads a thinned row, and the stored rows are
// whole. Each row thinned says which fields it lacks (fields_omitted: those it had, so a field never written is not
// said to be left out), and is never written back (write()). Unknown shapes and fields leave rows as they are.
const omitting = (omit: Record<string, string[]> | undefined, w: string) => (rs: Row[]): Row[] => {
  if (omit === undefined) return rs
  return rs.map((r) => {
    const gone = r.writer === w && Object.hasOwn(omit, r.shape) ? [...new Set(omit[r.shape])].filter((k) => Object.hasOwn(r, k)) : []
    if (gone.length === 0) return r
    const kept: Row = { ...r }
    for (const k of gone) delete kept[k]
    return { ...kept, [FIELDS_OMITTED]: gone }
  })
}

// Whether each grade counted, as the fold decides it, on every outcome row a read returns, under `standing` (counted, or
// why not: the fold's own reason; "replaced" when the same writer graded the same answer again later; "not_a_grader" for
// an outcome written in a role the fold takes no grade from). A reader shown a grade is shown its standing, so a grade
// the fold refused is never taken for one that counts. The standing is records' to say: a standing a writer put on its
// row is replaced. It is its own field, so the writer's own fields (a grader's why) are kept as written. Computed once per sequence number, from one pass of the fold's grades (the standing ones are
// each writer's latest valid grade of an answer, as standing() keeps them), and put on copies: the stored rows are
// never changed.
// A deadline the rule lapsed (fold.ts LAPSE: no row is written for it) is said on the deadline row itself, wherever it
// is read: lapsed {at, standing}, so a producer, a retrospective or the page sees why a request closed as failed.
let standingAt: { seq: number; why: Map<string, { counted: boolean; why?: string }>; lapses: Map<string, { counted: boolean; why?: string }> } | undefined
const withStanding = (out: Row[]): Row[] => {
  if (standingAt?.seq !== seq) {
    const all = grades(rows, seq, seq)
    const stands = new Set([...new Map(all.filter((g) => g.ok).map((g) => [g.key, g])).values()].map((g) => g.id))
    const of = (g: (typeof all)[number]) => (stands.has(g.id) ? { counted: true } : { counted: false, why: g.refused ?? "replaced" })
    const why = new Map(all.map((g) => [g.id, of(g)]))
    const lapses = new Map(all.filter((g) => g.by === LAPSE).map((g) => [g.judged, of(g)]))
    standingAt = { seq, why, lapses }
  }
  const { why: m, lapses } = standingAt
  if (!out.some((r) => r.shape === OUTCOME || lapses.has(r.id))) return out
  return out.map((r) => {
    const lapse = lapses.get(r.id)
    if (lapse !== undefined) return { ...r, lapsed: { at: r.at, standing: lapse } }
    if (r.shape !== OUTCOME) return r
    return { ...r, standing: m.get(r.id) ?? { counted: false, why: "not_a_grader" } }
  })
}

// A read that narrows nothing answers the whole store, serialized in one answer: one such call from any caller can hold
// records (and every walk reading it) for as long as that takes. So a plain read must name what it reads by (a shape,
// ids, the rows citing one row, or a non-empty where), or bound its answer with a limit. after_seq, has and latest_by
// narrow only beside one of those: alone, each still answers rows of every shape (after_seq 0 is the whole store). The
// limit bounds the answer, not the scan: the newest N are taken after the match. Checked before any row is read, and
// each field's type with it: a malformed field is the caller's to fix, refused by name (400), never a records fault.
const BY = ["shape", "ids", "refs_to", "where", "limit"] as const
const ONLY_BESIDE = ["after_seq", "has", "latest_by"] as const
const TYPES: Record<string, (v: unknown) => boolean> = {
  shape: (v) => typeof v === "string", refs_to: (v) => typeof v === "string", latest_by: (v) => typeof v === "string", has: (v) => typeof v === "string",
  ids: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  where: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  after_seq: (v) => typeof v === "number" && Number.isFinite(v),
  limit: (v) => Number.isInteger(v) && (v as number) > 0,
}
// omit is read on the episodes read alone (serveRead's roots: "all" branch), so it is checked there only; beside any
// other read it is ignored, as any field a read does not take.
const episodesRead = (q: Query): boolean => q.head !== true && !(typeof q.root === "string" && q.calls === "all") && typeof q.call_id !== "string" &&
  q.episode !== undefined && !Array.isArray(q.calls) && q.roots === "all"
const isOmit = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v).every((fs) => Array.isArray(fs) && fs.every((f) => typeof f === "string"))
export const unnarrowed = (q: Query): string | undefined => {
  const bad = Object.keys(TYPES).filter((k) => (q as Record<string, unknown>)[k] !== undefined && !TYPES[k]((q as Record<string, unknown>)[k]))
  if (bad.length > 0) return `record_read ${bad.map((k) => k === "limit" ? "limit must be a whole number above 0" : `${k} is not ${k === "ids" ? "a list of ids" : k === "where" ? "an object" : k === "after_seq" ? "a number" : "a string"}`).join("; ")}`
  if (q.omit !== undefined && episodesRead(q) && !isOmit(q.omit)) return "record_read omit is not an object of shape to a list of field names"
  if (q.head === true || q.call_id !== undefined || q.episode !== undefined || (q.root !== undefined && q.calls === "all")) return undefined
  const by = BY.filter((k) => q[k] !== undefined && !(k === "where" && Object.keys(q.where ?? {}).length === 0))
  return by.length > 0 ? undefined
    : `record_read names nothing to narrow by: give one of ${BY.join(", ")} (${ONLY_BESIDE.join(", ")} narrow only beside one of them)`
}

export const serveRead = (q: Query): Row[] | Call[] | ReturnType<typeof episodes> | { at_seq: number } => {
  // The store's latest seq alone (head: true): what a reader counting "rows written since" counts against, without
  // reading any rows or folding grades.
  if (q.head === true) return { at_seq: lastSeq() }
  if (typeof q.root === "string" && q.calls === "all") return rootCalls(q.root, q.output !== false)
  if (typeof q.call_id === "string") return oneCall(q.call_id)
  if (q.episode !== undefined && Array.isArray(q.calls)) return walkCalls(q.episode, q.calls)
  // The walk's own reads carry each outcome's standing too: its producers decide from these rows, and an outcome shown
  // without its standing reads as a grade that counted, even one the fold refused.
  if (q.episode !== undefined) {
    if (q.roots !== "all") return projected(withStanding(episode(q.episode)))
    const all = episodes(q.episode, q.arm === "beside")
    const thin = omitting(q.omit, q.episode)
    return { shared: thin(projected(withStanding(all.shared))), roots: all.roots.map((x) => ({ ...x, rows: thin(projected(withStanding(x.rows))) })) }
  }
  // Any other read ({ids}, {shape}, {where}): the selections are answered whole (a reader by id wants their refs), but a
  // hold the owner reads as a fact is shown as its fact here too. A call's stored output (rootCalls, oneCall, walkCalls)
  // is the answer the call got, kept as it was: a records read in it was made through this function.
  // Who is waiting on a person now: derived from the walk's failures, never a stored row (fold.ts openPersonWaits).
  if (q.shape === PERSON_WAIT) {
    const waits = openPersonWaits(rows)
    return q.limit === undefined ? waits : waits.slice(-q.limit)
  }
  // Where each open ask stands: derived from the rows on its root, never a stored row (openAskStates). where narrows it by
  // the row's own fields (an asker's own asks: where {asker}).
  if (q.shape === ASK_STATE) {
    // A where narrows to rows whose field holds the value named: a non-empty string matches only a string field equal
    // to it, a number only a number field equal to it. A value names one type, and a field held as the other is a
    // different value. Any other value (null, an empty string, an object) matches nothing, and neither does a field the
    // row holds as null: a missing user id passed through never reads as "every ask with none" (asker_user is null on
    // every unstamped ask).
    const holds = (got: unknown, v: unknown): boolean =>
      (typeof v === "string" && v !== "" && typeof got === "string" && got === v) ||
      (typeof v === "number" && typeof got === "number" && got === v)
    const states = openAskStates().filter((r) => Object.entries(q.where ?? {}).every(([k, v]) => holds(r[k], v)))
    return q.limit === undefined ? states : states.slice(-q.limit)
  }
  const matched = read(q)
  const kept = q.limit === undefined ? matched : matched.slice(-q.limit)
  return withStanding(q.stored === true ? kept : withUse(factsOn(kept)))
}

// WHETHER WHAT A SELECTION MADE WAS USED is records' to say (fold.ts useGrades): a selection read is stamped use {r, key}
// when the fold judged that selection by its use, and carries no use otherwise, whatever its writer put there. Derived
// on read and never stored, as standing is, so a detector that classes unused output reads this stamp, never a copy of
// the rule. Only on a plain read: the walk's episodes are answered as before.
let useAt: { seq: number; of: Map<string, { r: number; key: string }> } | undefined
const withUse = (out: Row[]): Row[] => {
  if (!out.some((r) => r.shape === SELECTION)) return out
  if (useAt?.seq !== seq) useAt = { seq, of: new Map(useGrades(rows, seq, seq).map((g) => [g.judged, { r: g.r, key: g.key }])) }
  const of = useAt.of
  return out.map((r) => {
    if (r.shape !== SELECTION) return r
    const { use: _u, ...rest } = r
    const u = of.get(r.id)
    return (u === undefined ? rest : { ...rest, use: u }) as Row
  })
}

// The self-check's open gaps from before they said walkable false are marked once as it loads (self-check.ts unmarked):
// last in the module, after everything a write reads is defined.
for (const g of selfChecks.unmarked()) write(g, VESSEL_ID, DETECTOR)

// SPDX-License-Identifier: MIT
import { ACTIVITY_TEMPLATE, ARM, CREDITS, DESCRIBED, DETECTOR, FAILURE, GAP, GIT_DIFF, HOP, LAND_VERDICT, OPERATOR, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, SHAPE_SCHEMA, TREATED, WALK , INFRA_WINDOW, PERSON_WAIT } from "./shapes"
import { deadlineAsks, declaredAsks, isAsk, isDeadline } from "./asks"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

// Rows a grade may take as given evidence: what a person, the owner or an operator asked or said. Only a person's grade
// is a verdict (GRADERS, and the o.role === PERSON checks below): an operator's grade counts for nothing.
const GIVEN = new Set([PERSON, OWNER, OPERATOR])
const GRADERS = new Set([DESCRIBED, PERSON])

// by: the grader's role (person, or described for the walk's own outcome); deadline: the judged row is a deadline, so
// a counted grade of it at r 0 is a lapse.
// refused: why a grade does not count, when it does not (the first reason that applies).
// The role a derived lapse is said by: no writer wrote it (records' rule did).
export const LAPSE = "lapse"
export type Grade = { id: string; ok: boolean; r: number; judged: string; key: string; cells: Set<string>; weights: Map<string, number>; by: string; deadline: boolean; refused?: string }

// What the owner's credits row for target "selection" says about how credit travels: the weight each kind of
// origination carries, the discount per consumption edge (gamma) and how far it goes (depth). The row is the only
// source of these (design: enablement-credit section 1). With no row, or a row with any field missing or out of range
// (the row is then unusable whole, not patched field by field), nothing travels: a grade credits only the selection
// that made the row it judged, counted once, unscaled. Either is said on records' output, once per change.
export type Travel = { w_person: number; w_lapse: number; w_close: number; gamma: number; depth: number; w_check?: number; promise_window?: number; prior_count?: number }
type Required = "w_person" | "w_lapse" | "w_close" | "gamma" | "depth"
const BOUNDS: Record<Required, [number, number]> = { w_person: [0, 10], w_lapse: [0, 10], w_close: [0, 10], gamma: [0, 1], depth: [0, 64] }
let said = ""
const say = (line: string): void => {
  if (line !== said) console.log(`[records] ${line}`)
  said = line
}
const travelOf = (seen: Row[]): Travel | undefined => {
  const row = seen.filter((r) => r.shape === CREDITS && r.role === OWNER && String(r.target) === SELECTION).sort((a, b) => a.seq - b.seq).at(-1)
  if (row === undefined) { say("credits selection row absent: depth 0 only"); return undefined }
  const bad = (Object.keys(BOUNDS) as Required[]).find((k) => {
    const v = row[k]
    return typeof v !== "number" || !Number.isFinite(v) || v < BOUNDS[k][0] || v > BOUNDS[k][1] || (k === "depth" && !Number.isInteger(v))
  })
  const id = String(row.id).replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 64)
  if (bad !== undefined) { say(`credits selection row ${id} ignored: ${bad} missing or out of range; depth 0 only`); return undefined }
  // A promise's weight and window are optional: a row without both (or with either out of range) settles no promise,
  // and no value is assumed in their place (law 1: the owner's row is the only source).
  const wc = row.w_check, pw = row.promise_window
  const promises = typeof wc === "number" && Number.isFinite(wc) && wc >= 0 && wc <= 10 && typeof pw === "number" && Number.isInteger(pw) && pw >= 1 && pw <= 64
  // A cap on how much of a coarser level's record a cell inherits (prior_count): optional; with none the whole record
  // is inherited (the USER: inherit, then refine), never a value assumed in its place.
  const pc = row.prior_count
  const nested = typeof pc === "number" && Number.isFinite(pc) && pc > 0 && pc <= 1000
  say(`credits selection row ${id} used${promises ? "" : "; no promise weight and window: promises settle nothing"}${nested ? `; inheritance capped at ${Number(pc)}` : ""}`)
  return { w_person: Number(row.w_person), w_lapse: Number(row.w_lapse), w_close: Number(row.w_close), gamma: Number(row.gamma), depth: Number(row.depth),
    ...(promises ? { w_check: Number(wc), promise_window: Number(pw) } : {}), ...(nested ? { prior_count: Number(pc) } : {}) }
}

const shapeOf = (e: unknown): string => typeof e === "object" && e !== null ? String((e as { shape?: unknown }).shape) : String(e)

// The selections a success reached, each once, at the weight of its shortest path. A selection consumed a row when:
// the row is of one of its produce's schema input shapes and in the produced row's input_refs; or the produced row
// names it in uses (and it was among the rows shown, input_refs); or the selection is a call and the row is its
// request (from); or it is a run and the row is its template. Credit passes from a selection to the selection that
// produced each row it consumed (that row's selection_ref). A row the producer was only shown, and did not name in
// uses, passes nothing: presence in a pool is not use. Every edge runs to a selection with a lower seq, so the walk
// ends.
// The rows reached() walks, indexed once per fold, not once per grade: what is by id, which rows are selections, what
// each selection produced, and each target's schema input shapes.
export type Index = { byId: Map<string, Row>; sels: Map<string, Row>; made: Map<string, Row[]>; inputs: Map<string, Set<string>>; failed: Set<string> }
export const indexOf = (seen: Row[]): Index => {
  const byId = new Map(seen.map((r) => [r.id, r]))
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const made = new Map<string, Row[]>()
  for (const r of seen) {
    if (typeof r.selection_ref !== "string" || r.role !== DESCRIBED || r.shape === OUTCOME) continue
    const list = made.get(r.selection_ref)
    if (list) list.push(r)
    else made.set(r.selection_ref, [r])
  }
  const inputs = new Map<string, Set<string>>()
  for (const s of seen.filter((r) => r.shape === SHAPE_SCHEMA && r.role === OWNER)) {
    const k = String(s.target)
    inputs.set(k, new Set([...(inputs.get(k) ?? []), ...[s.inputs ?? []].flat().map(shapeOf)]))
  }
  return { byId, sels, made, inputs, failed: failedOf(seen, sels) }
}

// WAITING ON A PERSON, one reading for every rule that asks it (a lapse, a derived lapse, a broken promise): at seq
// `at`, the root's latest walk failure before it that says waits_for person (its selection's root this root) has had no
// person row about the root since, up to and including `at` (a person row at that seq has spoken). About the root: a row
// citing it, or a row citing a row that cites it (the root itself always comes before its selections, waits and grades).
const refsOfRow = (r: Row | undefined): string[] => [r?.input_refs].flat().filter((x) => x !== undefined).map(String)
export const personWait = (seen: Row[], byId: Map<string, Row>) => {
  const persons = seen.filter((p) => p.role === PERSON)
  const waits = seen.filter((f) => f.shape === FAILURE && f.role === WALK && f.waits_for === "person")
  const about = (p: Row, root: string): boolean => refsOfRow(p).includes(root) || refsOfRow(p).some((id) => refsOfRow(byId.get(id)).includes(root))
  const waitingAt = (root: string, at: number): boolean => {
    const w = waits.filter((f) => f.seq < at && String(byId.get(String(f.selection_ref))?.root) === root).sort((x, y) => x.seq - y.seq).at(-1)
    return w !== undefined && !persons.some((p) => p.seq > w.seq && p.seq <= at && about(p, root))
  }
  return { persons, about, waitingAt }
}

// WHO IS WAITING ON A PERSON NOW (the person-waits ruling), by personWait's own reading at the store's newest row: each
// root whose latest walk failure saying waits_for person has had no person row about the root since. One derived row
// per such root, oldest first, named for that failure (person_wait:<its id>, the same across reads, never the failure's
// own id) and naming its root plainly, so a page can draw the ask beside it; with the tree and repo the wait is about
// as the failure row states them as fields (the walk lifting them from the tool's answer), never read from the failure's
// text, and null when it states none (a wait written before the walk named them), so a reader is told it is unknown.
// Derived only: records refuses a stored one.
export const openPersonWaits = (seen: Row[]): Row[] => {
  const byId = new Map(seen.map((r) => [r.id, r]))
  const { waitingAt } = personWait(seen, byId)
  const at = seen.reduce((m, r) => Math.max(m, r.seq), 0) + 1
  const latest = new Map<string, Row>()
  for (const f of seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.waits_for === "person").sort((x, y) => x.seq - y.seq)) {
    const root = byId.get(String(f.selection_ref))?.root
    if (typeof root === "string") latest.set(root, f)
  }
  return [...latest.entries()].filter(([root]) => waitingAt(root, at)).map(([root, f]) => ({
    shape: PERSON_WAIT, id: `${PERSON_WAIT}:${f.id}`, writer: "records", role: "records", root, waits_for: "person", seq: f.seq, t: f.t,
    selection_ref: f.selection_ref, input_refs: [f.id],
    tree: typeof f.tree === "string" ? f.tree : null, repo: typeof f.repo === "string" ? f.repo : null,
  }) as Row).sort((x, y) => x.seq - y.seq)
}

// WHETHER A WALK FAILURE SAYS ITS MOVE FAILED, one reading for every rule that asks which moves failed (the fold's index,
// grades, gap closures, promises, landings): any walk failure, whatever its status or kind, except a skip row (it names a
// template that could not run, and cites whichever selection the walk was making then) and except one inside an owner's
// infra window of its status (an outage or an install's restart cut the call: the move was stopped, not failed, so it
// neither stops credit through its selection nor counts against it). The window's rule is moveFailuresOf's: its span,
// written after the span, and the statuses it names.
const moveFailed = (seen: Row[]): ((r: Row) => boolean) => {
  const windows = infraWindowsOf(seen)
  return (r) => r.shape === FAILURE && r.role === WALK && r.kind !== "skip" && !inInfraWindow(r, windows)
}
// The selections whose own move failed: a failure row the walk that made the selection wrote (moveFailed).
const failedOf = (seen: Row[], sels: Map<string, Row>): Set<string> => new Set(seen
  .filter(moveFailed(seen))
  .filter((r) => sels.get(String(r.selection_ref))?.writer === r.writer)
  .map((r) => String(r.selection_ref)))

// A walk back may stop at a row it must not pass through (stopAt): the selection that produced that row is neither
// credited nor walked past.
// A RUN'S CREDIT IS EARNED BY A RUN THAT ENDED WELL (qa, agf_dagr3azgkhbr). A run selection whose move failed is a stop:
// never credited, never walked past to the template it ran or the selection that minted it. A produce that names the
// template itself in uses passes credit to its mint only when a run of that template, ended well, made a row
// this produce also consumed (any arm: a run of either arm walks on to its template through its own output anyway; a
// selection's arm decides whether its own cell is credited, below): naming a plan shown beside the work, without having used a run of it, is no evidence the
// plan worked.
// WHAT CROSSES TO ANOTHER ROOT'S WORK. An edge from a selection on one root to a row whose producing selection is on
// another root (today: a run of a plan minted elsewhere, back to its mint): a debit always crosses (a missed deadline
// always counts, by the owner's ruling, 11-16); credit crosses only from a person's grade (by the owner's ruling,
// 11-17). A debit is an origination at r 0, whoever gave it (a lapse, a broken promise, a grade of 0). origin: the originating grade's role
// (by, as on Grade) and its r. Any other r from a promise check or the walk's own grader (a kept promise, a grader's r
// above 0) stays in its own root's work.
// A selection with no root is not known to be on another one: the edge is walked as before. A citation alone (uses,
// with no grade) originates nothing: every walk back starts at a grade.
// Only PERSON is here. A detector's close does not travel through reached(): it credits the gap's own chain of
// selections (gapClosuresOf); if it ever travels here, it comes with its own leg. An operator's grade is deliberately
// absent: its credit stays in its root. A person row written by a peer is the records write-side class
// (agf_zgb2fw6ifh3f), not handled here.
const CROSSES = new Set([PERSON])
// One index per row list and at_seq: every grade source of one fold reads the same rows, so it is built once. A list
// that grows is indexed again; one changed in place would not be, which holds because the store only appends rows.
const indexes = new WeakMap<Row[], { n: number; at: Map<number, Index> }>()
const indexAt = (all: Row[], atSeq: number): Index => {
  let c = indexes.get(all)
  if (c === undefined || c.n !== all.length) { c = { n: all.length, at: new Map() }; indexes.set(all, c) }
  let i = c.at.get(atSeq)
  if (i === undefined) { i = indexOf(all.filter((r) => r.seq <= atSeq)); c.at.set(atSeq, i) }
  return i
}
// The rows a selection consumed (the rule above reached): one reading for reached() and the use grade.
const consumedOf = (index: Index): ((sel: Row) => string[]) => {
  const { byId, sels, made, inputs, failed } = index
  const okRun = (sid: unknown): Row | undefined => {
    const s = sels.get(String(sid))
    return s !== undefined && String(s.a ?? "").startsWith("run/") && !failed.has(s.id) ? s : undefined
  }
  return (sel: Row): string[] => {
    const a = String(sel.a ?? "")
    if (a.startsWith("call/")) return sel.from === undefined ? [] : [String(sel.from)]
    if (a.startsWith("run/")) return [a.slice("run/".length)]
    return (made.get(sel.id) ?? []).flatMap((p) => {
      const shown = new Set([p.input_refs].flat().map(String))
      const ins = inputs.get(String(p.shape)) ?? new Set<string>()
      const asInput = [...shown].filter((id) => ins.has(String(byId.get(id)?.shape)))
      const used = [p.uses ?? []].flat().map(String).filter((id) => shown.has(id))
      const rows = [...asInput, ...used]
      return rows.filter((id) => {
        if (byId.get(id)?.shape !== ACTIVITY_TEMPLATE) return true
        return rows.some((x) => okRun(byId.get(x)?.selection_ref)?.a === `run/${id}`)
      })
    })
  }
}
export const reached = (index: Index, start: string, t: Travel, origin: { by: string; r: number }, stopAt?: (row: Row) => boolean): Map<string, number> => {
  const crosses = origin.r === 0 || CROSSES.has(origin.by)
  const { byId, sels, failed } = index
  const consumed = consumedOf(index)
  const out = new Map<string, number>()
  const seenSel = new Set<string>([start])
  let level = [start]
  for (let k = 0; level.length > 0 && k <= t.depth; k++) {
    const next: string[] = []
    for (const id of level) {
      out.set(id, Math.pow(t.gamma, k))
      const sel = sels.get(id)
      if (sel === undefined) continue
      for (const x of consumed(sel)) {
        if (stopAt !== undefined && byId.get(x) !== undefined && stopAt(byId.get(x)!)) continue
        const p = byId.get(x)?.selection_ref
        if (typeof p === "string" && String(sels.get(p)?.a ?? "").startsWith("run/") && failed.has(p)) continue // a failed run: a stop
        const from = sel.root, to = sels.get(String(p))?.root
        if (!crosses && typeof from === "string" && typeof to === "string" && from !== to) continue // another root's work: a stop
        if (typeof p === "string" && sels.has(p) && !seenSel.has(p) && (sels.get(p)?.seq ?? Infinity) < sel.seq) { seenSel.add(p); next.push(p) }
      }
    }
    level = next
  }
  return out
}

// Every grade among the rows, with whether it counts and what it judges. The fold folds the ones that count; the
// lapse detector uses the same answer, so a grade the fold refuses never hides a lapse.
const gradesOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const byId = new Map(seen.map((r) => [r.id, r]))
  // what an ask is, as the rows it is read at declare it (asks.ts): a person's grade is never one
  const declared = declaredAsks(seen)
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const treated = (id: unknown): boolean => String(sels.get(String(id))?.arm) === TREATED
  // A selection whose move failed produced nothing a grade can be crediting, so it is left out of every chain.
  const failed = failedOf(seen, sels)
  // A grade (a person's verdict or a described outcome) judges one answer it saw (any described row that is not a grade,
  // so a due row is answer-like: grading it r 1 credits the steps that made it): the answer in its input_refs, or, when
  // it saw several, the one its evidence_refs names. It credits the composition that made that answer: the answer's
  // selection and every earlier treated selection in that selection's pool. A described grade counts only when all it
  // saw was the request, owner rows and answers. r must be a number from 0 to 1, and only a writer's latest valid grade
  // of an answer counts: a repeat replaces, never adds. A judged row that carries a deadline (within_ms, which records
  // made into `at`) lapsed rather than answered: its grade counts only as r 0 and only when records stamped the grade after the deadline, and it also
  // credits the treated steps the grader's selection held after that row, which are the waits that let it lapse.
  // What a grade may see is the owner's to say, in its newest outcome schema row's context. An entry there is a shape,
  // or {shape, where}: rows of that shape whose fields hold where's values (a list: any of them).
  //  - What a grade may be judging: a described row of a shape the context names (an answer, a deadline), never another
  //    described row it happened to see (a request, a judgment of the ask). With no such row, any described row that is
  //    not a grade, as before.
  //  - A row a where entry names (what a tool call returned, in its ended hop) is given evidence: the owner chose it, and
  //    the walk did not author it. Seeing it leaves a grade clean; a row of the walk's no where entry names (a produce
  //    or wait hop, a started hop, a selection) does not.
  const outcomeSchema = seen.filter((r) => r.shape === SHAPE_SCHEMA && r.role === OWNER && String(r.target) === OUTCOME && !r.variant)
    .sort((a, b) => a.seq - b.seq).at(-1)
  const entries: unknown[] | undefined = outcomeSchema ? [outcomeSchema.context ?? []].flat() : undefined
  const matches = (r: Row, e: unknown): boolean => {
    if (typeof e === "string") return r.shape === e
    if (typeof e !== "object" || e === null) return false
    const { shape, where } = e as { shape?: unknown; where?: Record<string, unknown> }
    return r.shape === String(shape) && Object.entries(where ?? {}).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v)
  }
  const gradable = (r: Row): boolean => entries === undefined || entries.some((e) => matches(r, e))
  const travel = travelOf(seen)
  let index: Index | undefined
  const idx = (): Index => (index ??= indexAt(all, atSeq))
  const given = (r: Row): boolean => (entries ?? []).some((e) => typeof e === "object" && e !== null && "where" in e && matches(r, e))
  // A LAPSE A PERSON OVERTOOK, OR ONE WRITTEN WHILE THE REQUEST WAITED ON A PERSON (the USER, 11-16 ~09:50Z: "Yes, your
  // later grade reopens it"; "No lapse while waiting"). A person's grade (a person row with a numeric r) on the request,
  // or on a row citing it, written after the lapse, overrides it: the request is open again, the person's latest mark
  // decides, and the lapse debits no one. And a lapse written while a call made for the request waited on a person (the
  // walk's failure saying waits_for person, with no person row on the request since) is a fact about the person's time,
  // not the makers' work: it debits no one and closes nothing. A note with no r, a model's grade, or a mark on another
  // request changes nothing.
  const refsOf = refsOfRow
  const { persons, about, waitingAt } = personWait(seen, byId)
  const graded = persons.filter((p) => typeof p.r === "number" && Number.isFinite(p.r))
  const overtaken = (req: string, at: number): boolean => graded.some((p) => p.seq > at && about(p, req))
  // A PROMISE IS EXEMPT FROM THE GRADER UNTIL ITS ASK'S FIRST DEADLINE (the USER, 11-16: "Exempt until deadline"; its
  // promise is graded by what happens next). A grade the walk's grader wrote of an answer that promises (promises(), the
  // owner's entry) before the first deadline of the ask it answers has come counts for nothing ("exempt"): a fact about
  // when, not the grader's fault, so it debits no one. The walk's due/grade rule is to stop offering such a grade (not yet
  // installed); this is the same rule where grades count, for one the grader judges anyway. A person's grade is never
  // exempt. With no deadline row for the ask the promise stays exempt from the grader; the promise rule (kept or broken
  // within the owner's window) still grades it where a change was wanted.
  // Each ask's first deadline row, found in one pass over the rows when first asked, not a pass (and a sort) per call:
  // the lowest seq, and on an equal seq the row earlier in the list, as the stable sort chose.
  let deadlines: Map<string, Row> | undefined
  const deadlinesOf = (): Map<string, Row> => {
    const first = new Map<string, Row>()
    for (const r of seen) {
      if (r.role !== DESCRIBED || typeof r.within_ms !== "number" || typeof r.at !== "number") continue
      for (const ask of refsOf(r)) {
        const had = first.get(ask)
        if (had === undefined || r.seq < had.seq) first.set(ask, r)
      }
    }
    return first
  }
  const firstDeadline = (ask: string): number | undefined => (deadlines ??= deadlinesOf()).get(ask)?.at as number | undefined
  const exempt = (o: Row, j: Row | undefined): boolean => {
    if (o.role === PERSON || j === undefined || !promises(seen, j)) return false
    const asks = refsOf(j).filter((id) => isAsk(byId.get(id), declared))
    return asks.length > 0 && asks.every((ask) => { const at = firstDeadline(ask); return at === undefined || at > Date.parse(String(o.t)) })
  }
  const credit = (o: Row): Grade => {
    const saw = [o.input_refs].flat().map((id) => byId.get(String(id)))
    const answers = saw.filter((r) => r !== undefined && r.role === DESCRIBED && r.shape !== OUTCOME && gradable(r))
    const named = [o.evidence_refs].flat().filter((id) => id !== undefined).map(String)
    const judged = named.length > 0 ? answers.filter((a) => named.includes(String(a?.id))) : answers
    const s = sels.get(String(judged[0]?.selection_ref))
    // The row a described grade judges must belong to the request it graded: it cites a person or owner row the grade
    // also saw. A grader shown another request's deadline or answer judges nothing here.
    const ours = o.role === PERSON || [judged[0]?.input_refs].flat().some((id) => saw.some((r) => r !== undefined && r.id === String(id) && GIVEN.has(r.role)))
    const clean = saw.every((r) => r !== undefined && (GIVEN.has(r.role) || answers.includes(r) || given(r)))
    const r = Number(o.r)
    const j = judged[0]
    const deadline = j !== undefined && typeof j.within_ms === "number" && typeof j.at === "number"
    const timely = !deadline || (r === 0 && Date.parse(String(o.t)) >= Number(j?.at))
    // A lapse (r 0 on a deadline row, stamped after it) is a fact about the clock, not a judgment of the walk's work: what
    // else the grader saw cannot make it less independent, so it counts clean or not. A grade of an answer still must be
    // clean. (Outcome graders read hops, so without this no lapse counted, and no lapsed request ever closed.)
    const lapse = deadline && r === 0 && timely
    const refused = !(typeof o.r === "number" && Number.isFinite(r) && r >= 0 && r <= 1) ? "r"
      : judged.length !== 1 || !ours ? "judged"
      : s === undefined || !treated(s.id) || (o.role !== PERSON && !treated(o.selection_ref)) ? "untreated"
      : exempt(o, j) ? "exempt"
      : o.role !== PERSON && !(clean || lapse) ? "unclean"
      : !timely ? "untimely"
      // (after untimely: an early grade, or an r 1, of a deadline was never a lapse and stays untimely, so it hides nothing
      // from record_lapsed)
      // A DEADLINE IS THE RULE'S TO RECORD (the USER, 11-16: "Yes, a fixed rule records it"). A model's grade of a
      // deadline row is kept, and counts for nothing: it neither closes the request nor debits anyone, and the deadline
      // stays ungraded, so the rule's own lapse (derived below) decides it, with the rule's exemptions (a person's later
      // grade, a wait on a person). Otherwise the walk's grader, choosing its own moment, closed a person's ask failed
      // with no person's mark and no rule (489005d3, 2814ca76). A person's grade of a deadline is theirs to give.
      : deadline && o.role !== PERSON ? "by_rule"
      : lapse && refsOf(j).some((req) => overtaken(req, o.seq)) ? "person_later"
      : lapse && refsOf(j).some((req) => waitingAt(req, o.seq)) ? "person_wait"
      : undefined
    const ok = refused === undefined
    // What it credits: the selection that made the judged row, and every selection whose output that one consumed,
    // back along consumption (reached), each once at w·gamma^k for its shortest distance k. Never the pool it saw.
    const weights = new Map<string, number>()
    if (ok && s !== undefined) {
      for (const [id, g] of travel === undefined ? new Map([[s.id, 1]]) : reached(idx(), s.id, travel, { by: String(o.role), r })) {
        if (!treated(id) || failed.has(id)) continue
        const c = String(sels.get(id)?.cell)
        weights.set(c, Math.max(weights.get(c) ?? 0, g))
      }
    }
    return { id: o.id, ok, r, judged: String(judged[0]?.id), key: [o.writer, judged[0]?.id].join("|"), cells: new Set(weights.keys()), weights, by: String(o.role), deadline, ...(refused ? { refused } : {}) }
  }
  const real = seen
    .filter((r) => r.shape === OUTCOME)
    .filter((r) => GRADERS.has(r.role))
    .filter((r) => r.seq <= asOf)
    .map(credit)
  // A DEADLINE THAT PASSED UNGRADED IS A LAPSE BY RULE (the USER, 11-16: "Yes, a fixed rule records it"). A lapse was
  // a grade the walk's grader had to choose to write, so a busy root lost it in every draw and never closed (489: its
  // first deadline passed at 11:58 and stayed ungraded). Now, as lapsed() reads it, an ask's deadline row (a producer's,
  // with within_ms and the at records stamped), once its at has passed by the store's own clock (the time of the newest
  // row at asOf, so a replay answers the same), with no counted grade of it and the ask not closed by a person's Right on
  // a result, is a lapse: r 0 on that deadline, at the first row written after it, crediting the deadline's chain as a
  // written lapse does. No row is written; it is derived the same way on every read. The rules a written lapse meets
  // hold: a later person grade on the ask's rows overtakes it, and none while a call waits on a person.
  // EVERY DEADLINE, NOT ONLY THE FIRST (the USER, 11-20: "Later deadlines close it"). A person's later mark overtakes a
  // lapse and reopens the ask; with only the first deadline judged, a reopened ask could then close only by a person's
  // Right, and was worked with nothing ever counting against it. So each deadline row is judged, in seq order, and the
  // first that stands closes the ask: later ones derive nothing, one debit per miss. A refused one closes nothing and
  // the next deadline is judged anew. A deadline citing several asks closes them all (closed() reads its input_refs), so
  // it is refused if a person overtook, or a call waits on a person on, any of the asks it would close, as a written lapse
  // is: a mark on an open ask is never closed over. An ask already closed has nothing to protect: closing it again changes
  // nothing, and its mark or wait refusing would leave the open ask beside it never closing (live deadlines often cite a
  // closed ask beside the open one).
  // Each row's time is parsed once, and rows are in seq order with t stamped at write (rising with seq), so the first
  // row at or after a deadline is found by binary search: the rule costs a pass over the rows, not a pass per ask (qa).
  const timeline = seen.filter((r) => r.seq <= asOf).sort((a, b) => a.seq - b.seq)
  const times = timeline.map((r) => Date.parse(String(r.t)))
  const now = times.length > 0 ? times[times.length - 1] : NaN
  const firstAtOrAfter = (at: number): Row | undefined => {
    let lo = 0, hi = times.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] >= at) hi = mid; else lo = mid + 1 }
    return timeline[lo]
  }
  const counted = new Set(real.filter((g) => g.ok).map((g) => g.judged))
  const asksOf = (r: Row | undefined): string[] => refsOf(r).filter((id) => isAsk(byId.get(id), declared))
  // the asks a written grade already closed, as closed() and lapsed() read them: a person's Right on a result (not on a
  // promise: "Accurate, not done"), or a counted written lapse on any of its deadlines. Found once. A derived lapse on
  // such an ask would only add a second debit for the same miss (database: 5 asks closed by written lapses).
  // Only a grade that stands closes (latestOf, standing()'s own rule): a person's Right they later marked down no longer
  // closes the ask, so it no longer exempts the ask from its next deadline.
  const reachedAsks = new Set(latestOf(real).filter((g) => (g.r === 1 && g.by === PERSON && !promises(seen, byId.get(g.judged))) || (g.r === 0 && g.deadline))
    .flatMap((g) => asksOf(byId.get(g.judged))))
  const lapsedAsks = new Set<string>()
  const derived: Grade[] = []
  for (const due of timeline) {
    const asks = deadlineAsks(due, (id) => byId.get(id), declared).filter((ask) => !reachedAsks.has(ask) && !lapsedAsks.has(ask))
    if (asks.length === 0 || !(Number(due.at) < now) || counted.has(due.id)) continue
    const at = firstAtOrAfter(Number(due.at))
    if (at === undefined) continue
    const s = sels.get(String(due.selection_ref))
    const refused = s === undefined || !treated(s.id) ? "untreated"
      // the wait as it stood when the deadline passed: every row strictly before the row that shows it passed (seq
      // at.seq - 0.5: a wait written just before counts, and a person row AT it does not end the wait). That row may be
      // the person's own mark, which speaks after the deadline, not before it (deployment)
      : asks.some((ask) => overtaken(ask, at.seq)) ? "person_later"
      : asks.some((ask) => waitingAt(ask, at.seq - 0.5)) ? "person_wait" : undefined
    const weights = new Map<string, number>()
    if (refused === undefined && s !== undefined) {
      for (const [id, g] of travel === undefined ? new Map([[s.id, 1]]) : reached(idx(), s.id, travel, { by: LAPSE, r: 0 })) {
        if (!treated(id) || failed.has(id)) continue
        const c = String(sels.get(id)?.cell)
        weights.set(c, Math.max(weights.get(c) ?? 0, g))
      }
    }
    derived.push({ id: `lapse:${due.id}`, ok: refused === undefined, r: 0, judged: due.id, key: `lapse|${due.id}`, cells: new Set(weights.keys()),
      weights, by: LAPSE, deadline: true, ...(refused ? { refused } : {}) })
    if (refused === undefined) for (const ask of asks) lapsedAsks.add(ask)
  }
  return [...real, ...derived]
}

// How the walk's own grades (described outcomes) fared, over every one written: how many were written and how many
// counted, of answers and of deadlines (lapses) apart, and why the rest did not count. A detector reads it to see grades
// being written that the fold never counts. Cumulative: a reader compares two of these to see what changed between.
// A detector's closing of a gap (gapClosures) is tallied as a kind of its own, so a credit path that never counts (written,
// none counted) shows.
// untargeted: of the model's counted grades of 1 on an answer, how many were of a request that named no target, while the
// owner's grader holds grades to targets (its outcome schema's x-reach: {from, field}, the request's newest `from` row
// citing it, its field `field`). Such a grade is held to nothing but the answer's claim, so the count says how often
// that exit is still taken; with no reach rule, 0. Names no shape: where targets live is the owner's schema's word.
export type Tally = { written: { answer: number; lapse: number; detector: number }; counted: { answer: number; lapse: number; detector: number }; refused: Record<string, number>; untargeted: number }
const reachOf = (all: Row[]): { from: string; field: string } | undefined => {
  const x = (outcomeSchemaOf(all)?.schema as Record<string, unknown> | undefined)?.["x-reach"] as Record<string, unknown> | undefined
  return typeof x?.from === "string" && typeof x?.field === "string" ? { from: x.from, field: x.field } : undefined
}
// Per row list (and length: lists are append-only), the rows by id and each request's target rows, found once: tally is
// read with every posterior.
const targetIndex = (() => {
  const byList = new WeakMap<Row[], { n: number; key: string; byId: Map<string, Row>; of: Map<string, Row[]> }>()
  return (all: Row[], src: { from: string; field: string }) => {
    const key = `${src.from}|${src.field}`
    const c = byList.get(all)
    if (c !== undefined && c.n === all.length && c.key === key) return c
    const of = new Map<string, Row[]>()
    for (const r of all.filter((x) => x.shape === src.from)) for (const id of [r.input_refs].flat().map(String)) of.set(id, [...(of.get(id) ?? []), r])
    const v = { n: all.length, key, byId: new Map(all.map((r) => [r.id, r])), of }
    byList.set(all, v)
    return v
  }
})()
export const tally = (all: Row[], asOf: number, atSeq: number): Tally => {
  const t: Tally = { written: { answer: 0, lapse: 0, detector: 0 }, counted: { answer: 0, lapse: 0, detector: 0 }, refused: {}, untargeted: 0 }
  const src = reachOf(all)
  const idx = src === undefined ? undefined : targetIndex(all, src)
  for (const g of [...grades(all, asOf, atSeq).filter((x) => x.by === DESCRIBED), ...gapClosures(all, asOf, atSeq)]) {
    const kind = g.by === DETECTOR ? "detector" : g.deadline ? "lapse" : "answer"
    t.written[kind]++
    if (g.ok) t.counted[kind]++
    else t.refused[g.refused ?? "other"] = (t.refused[g.refused ?? "other"] ?? 0) + 1
    if (src !== undefined && idx !== undefined && g.ok && kind === "answer" && g.r === 1) {
      const o = idx.byId.get(g.id)
      // The request it graded: the root the producer's vessel stamps from the walk's selection (never the model's), else,
      // on a grade written before that stamp, the event_ref the model was asked to name.
      const root = String(o?.root ?? o?.event_ref ?? "")
      const newest = (idx.of.get(root) ?? []).filter((r) => r.seq <= (o?.seq ?? Infinity)).sort((a, b) => b.seq - a.seq)[0]
      const named = newest?.[src.field]
      if (!Array.isArray(named) || named.length === 0) t.untargeted++
    }
  }
  return t
}

// The grades that stand: those that count, and of each writer's grades of one answer only the latest (a repeat
// replaces, never adds), as the fold below folds them. A person who grades an answer r 1 and then r 0 has not closed it.
// AN ANSWER THAT PROMISES THE NEXT ACT IS NOT THE RESULT (the USER, 11-16 ~10:25Z: "Accurate, not done"). A person's
// Right on it says the answer is true, not that the work is done: the request stays open, and the promise is graded by
// what happens. Which answers promise is the owner's to say, in its newest outcome schema's evidence: an entry
// {shape, deferred_by: f} marks a row of that shape carrying f (not null) as a promise; only the owner's newest
// non-variant schema counts. The walk's due/grade rule is to read the same entry (not yet installed). With no such
// entry, no answer promises, as before.
// The newest owner outcome schema of a row list, found once per list (and its length: lists are append-only), not per
// call: promises() is asked for every grade, and a filter of the whole store each time made a cold standing() ~18x
// slower on the live rows (database).
export const outcomeSchemaOf = (() => {
  const byList = new WeakMap<Row[], { n: number; schema: Row | undefined }>()
  return (all: Row[]): Row | undefined => {
    const c = byList.get(all)
    if (c !== undefined && c.n === all.length) return c.schema
    const schema = all.filter((x) => x.shape === SHAPE_SCHEMA && x.role === OWNER && String(x.target) === OUTCOME && !x.variant)
      .sort((a, b) => a.seq - b.seq).at(-1)
    byList.set(all, { n: all.length, schema })
    return schema
  }
})()
export const promises = (all: Row[], r: Row | undefined): boolean => {
  if (r === undefined) return false
  const schema = outcomeSchemaOf(all)
  return [schema?.evidence ?? []].flat().some((e) => typeof e === "object" && e !== null &&
    (e as { shape?: unknown }).shape === r.shape && typeof (e as { deferred_by?: unknown }).deferred_by === "string" &&
    r[(e as { deferred_by: string }).deferred_by] !== undefined && r[(e as { deferred_by: string }).deferred_by] !== null)
}

// Of a writer's counted grades of one row, only the latest stands: one rule for standing() and the deadline rule's
// closed asks.
const latestOf = (gs: Grade[]): Grade[] => [...new Map(gs.filter((k) => k.ok).map((k) => [k.key, k])).values()]
export const standing = (all: Row[], asOf: number, atSeq: number): Grade[] => latestOf(grades(all, asOf, atSeq))

// Whom a move's failure blames, decided once, here, and stamped on the failure row when it is written (store.ts), so
// every reader (this fold, and the walk deciding whether to call the same pointer again) reads one answer:
//   request: the vessel called answered and refused what was asked: a 200 carrying an error, or a 4xx other than
//            401/403 (the caller's credentials, which rotate) and 408/429 (the callee was busy);
//   callee:  anything else, an outage, a timeout or a transport error: not the move's fault;
//   walk:    the walk declined to run or record it (a kind of its own: skip, too_big, unrunnable).
// A call that never reached a producer (unserved: the shape, on the failure row, lifted by the walk from the router's
// own answer, a resolver's refusal or a producer's failure envelope) is the callee's: nothing was asked of any producer,
// so no producer and none of the chain is debited, whatever the status (a routed 404 included). Read from the field.
// A refusal the walk recorded as waiting for a person (waits_for: "person" on the failure row, lifted from git_land's
// answer: the change touches what judges changes, and only a person's verdict lands it) is the gate working, not a
// fault in what was asked: callee. Read from the row's field only, never from its body.
const NOT_THE_REQUEST = new Set([401, 403, 408, 429])
export const blames = (f: Record<string, unknown>): "request" | "callee" | "walk" => {
  if (f.kind !== undefined) return "walk"
  if (f.waits_for === "person") return "callee"
  if (typeof f.unserved === "string" && f.unserved !== "") return "callee"
  const s = f.status
  return typeof s === "number" && (s === 200 || (s >= 400 && s < 500 && !NOT_THE_REQUEST.has(s))) ? "request" : "callee"
}
// A row written before the stamp keeps the rule it was counted by then: a 4xx that blames the request.
const blamed = (f: Row): string => typeof f.blames === "string" ? f.blames
  : (f.kind === undefined && typeof f.status === "number" && f.status !== 200 && blames(f) === "request" ? "request" : "callee")

// A move whose failure blames the request counts as r 0 for one cell: the move that chose what was asked. Of a call
// made for a request row (its selection's from), that is the produce that wrote the request: what the vessel refused is
// the pointer the request carried, not the act of calling it, so the call's own cell is left as it was (law 12: credit
// to the cause recorded when the choice was made). Of any other move (a template's run, a call with no request) it is
// the move itself. Either way: treated, by the walk that wrote the failure; once per failing selection; never a chain,
// since nothing was produced. Kept apart from grades(): what closes a request and what lapses never read it, and its key
// cannot replace a grade's.
// The owner's marks that a span of the store was an outage (the USER, 11-15: "Owner row marks window"): each infra_window
// row names a span (from_seq, to_seq) and the failure statuses it covers; a walk failure inside a span, of a status it
// names, debits no one. Only the classes named: a refusal of another status in the same span still counts. A window
// covers only rows written before it (its span ends at its own seq at the latest), so no row excuses failures yet to
// come (qa: a standing exemption would be a fiat that never ends). The latest row per window_id decides (a later row
// with retracted: true withdraws it). Rows that do not say all three are ignored.
type InfraWindow = { from: number; to: number; statuses: Set<number> }
const infraWindowsOf = (seen: Row[]): InfraWindow[] => {
  const latest = new Map<string, Row>()
  for (const r of seen.filter((x) => x.shape === INFRA_WINDOW && x.role === OWNER).sort((a, b) => a.seq - b.seq)) latest.set(String(r.window_id ?? r.id), r)
  return [...latest.values()].filter((r) => r.retracted !== true).flatMap((r) => {
    const from = Number(r.from_seq), to = Math.min(Number(r.to_seq), r.seq)
    const statuses = [r.statuses].flat().filter((x): x is number => typeof x === "number" && Number.isInteger(x))
    return Number.isFinite(from) && Number.isFinite(to) && from <= to && statuses.length > 0 ? [{ from, to, statuses: new Set(statuses) }] : []
  })
}
const inInfraWindow = (f: Row, windows: InfraWindow[]): boolean =>
  windows.some((w) => f.seq >= w.from && f.seq <= w.to && w.statuses.has(Number(f.status)))
// A produce refused only for citing values it was shown is a context gap, not a fault of what it drafted: described
// found each value it was not offered as a citation in an identifier field of a row it showed, and said so in its own
// refusal (context_gap: each value and the shown row it was seen in), which the walk lifts from that envelope only. The
// refusal still stands, so the selection is not credited (moveFailed is unchanged); it is not charged. A refusal naming
// any value seen nowhere carries no context_gap and is charged as before. Only a produce's refusal: a call's or a run's
// failure is a tool's answer, which cannot spare its own move, or its template's writer, by carrying the field.
const contextGap = (f: Row, s: Row): boolean => String(s.a ?? "").startsWith("produce/") && Array.isArray(f.context_gap) && f.context_gap.length > 0

const moveFailuresOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const windows = infraWindowsOf(seen)
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const byId = new Map(seen.map((r) => [r.id, r]))
  const out = new Map<string, Grade>()
  for (const f of seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.seq <= asOf)) {
    const s = sels.get(String(f.selection_ref))
    if (s === undefined || String(s.arm) !== TREATED || s.writer !== f.writer) continue
    if (blamed(f) !== "request") continue
    if (inInfraWindow(f, windows)) continue
    if (contextGap(f, s)) continue
    const asked = s.from === undefined ? undefined : byId.get(String(s.from))
    const wrote = asked === undefined ? undefined : sels.get(String(asked.selection_ref))
    const chose = wrote !== undefined && String(wrote.arm) === TREATED && wrote.writer === f.writer ? wrote : s
    out.set(s.id, { id: f.id, ok: true, r: 0, judged: chose.id, key: `fail|${s.id}`, cells: new Set([String(chose.cell)]), weights: new Map([[String(chose.cell), 1]]), by: WALK, deadline: false })
    // A template's run that failed is also the plan's failure: r 0 for the treated selection that wrote the template, once
    // per failing run, every run (the USER, 11-15 ~09:00Z: "a failed run debits the writer"; and "template-run failures
    // debit the mint cell, no positive credit from use alone"). Never a credit: a writer earns only through its runs'
    // consequences, as any move does.
    const a = String(s.a ?? "")
    const t = a.startsWith("run/") ? byId.get(a.slice("run/".length)) : undefined
    const writer = t !== undefined && t.shape === ACTIVITY_TEMPLATE ? sels.get(String(t.selection_ref)) : undefined
    if (writer !== undefined && String(writer.arm) === TREATED) {
      out.set(`mint|${s.id}`, { id: f.id, ok: true, r: 0, judged: writer.id, key: `mint|${s.id}`, cells: new Set([String(writer.cell)]), weights: new Map([[String(writer.cell), 1]]), by: WALK, deadline: false })
    }
  }
  // A plan this request cannot fill (the walk's skip naming unbound placeholders, or a run stopped at one: kind unbound)
  // failed as written, not as run: r 0 for the selection that WROTE the template, once per request, template and
  // placeholder (the USER, 11-15 ~08:10Z: "Debit the writer once (Recommended)"). The same unfilled placeholder seen again
  // in the same request is not counted again; a template no treated walk selection wrote debits no one.
  for (const f of seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.seq <= asOf && (r.kind === "skip" || r.kind === "unbound"))) {
    const holes = [f.unbound].flat().filter((x): x is string => typeof x === "string" && x !== "")
    const s = sels.get(String(f.selection_ref))
    const t = byId.get(String(f.template_ref))
    const wrote = t === undefined || t.shape !== ACTIVITY_TEMPLATE ? undefined : sels.get(String(t.selection_ref))
    if (s === undefined || s.writer !== f.writer || wrote === undefined || String(wrote.arm) !== TREATED) continue
    for (const h of holes) {
      const key = `unbound|${String(s.root ?? s.id)}|${t!.id}|${h}`
      if (!out.has(key)) out.set(key, { id: f.id, ok: true, r: 0, judged: wrote.id, key, cells: new Set([String(wrote.cell)]), weights: new Map([[String(wrote.cell), 1]]), by: WALK, deadline: false })
    }
  }
  return [...out.values()]
}

// A gap no one asked for is closed only by its detector (a later row of the same gap_id that is not open: its check
// passed), and no one grades the walk's work on it, so without this a gap root's steps could only ever lose. A detector's
// closing counts as r 1 for the steps the walk took on that gap, by the same chain rule as an answer's grade, but only
// when the walk changed something there first (law 12: a gap an operator fixed, or a check that turned green on its own,
// is not the walk's): a call of the shape the owner's credits row names (by_call) ended, joined to its started hop by
// call_id, in a treated selection of that episode with no failure, before the closing row. Otherwise it is refused as
// no_change. An episode runs from the gap's previous closing (or its first row) to this one, so a gap that reopens and
// closes again credits only the work since it reopened. Kept apart from grades(): what closes a request and what lapses
// never read it. With no credits row, nothing is credited.
// Residual (debt): an operator fix that lands beside a walk landing on the same gap still credits the walk; a closing
// row citing what its check judged would tie it causally.
// The closure grades as first written: every closure scans every treated selection. Kept as the oracle the lazy form
// below is tested against (byte-equal grades); nothing else calls it.
export const gapClosuresScan = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const rule = seen.filter((r) => r.shape === CREDITS && r.role === OWNER && String(r.target) === GAP).sort((a, b) => a.seq - b.seq).at(-1)
  const by = typeof rule?.by_call === "string" && rule.by_call !== "" ? rule.by_call : undefined
  if (by === undefined) return []
  const sels = seen.filter((r) => r.shape === SELECTION && String(r.arm) === TREATED)
  const failed = new Set(seen
    .filter(moveFailed(seen))
    .map((r) => String(r.selection_ref)))
  const started = new Map(seen.filter((r) => r.shape === HOP && r.role === WALK && r.phase === "started" && r.pointer_type === by)
    .map((r) => [String(r.call_id), r]))
  const ended = seen.filter((r) => r.shape === HOP && r.role === WALK && r.phase === "ended" && started.has(String(r.call_id)))
  const out: Grade[] = []
  const byGap = new Map<string, Row[]>()
  for (const r of seen.filter((x) => x.shape === GAP && x.role === DETECTOR && x.gap_id !== undefined).sort((a, b) => a.seq - b.seq)) {
    if (!byGap.has(String(r.gap_id))) byGap.set(String(r.gap_id), [])
    byGap.get(String(r.gap_id))!.push(r)
  }
  for (const rows of byGap.values()) {
    let since = 0
    let open: string[] = []
    for (const c of rows) {
      if (c.status === "open") { open.push(c.id); continue }
      if (open.length > 0 && c.seq <= asOf) {
        const held = (s: Row) => [s.pool_refs, s.input_refs].flat().map(String).some((id) => open.includes(id))
        const chain = sels.filter((s) => s.seq > since && s.seq < c.seq && held(s) && !failed.has(s.id))
        const ids = new Set(chain.map((s) => s.id))
        const landed = ended.some((e) => e.seq < c.seq && ids.has(String(started.get(String(e.call_id))?.selection_ref)))
        out.push({
          id: c.id, ok: landed, r: 1, judged: c.id, key: `gap|${c.id}`, cells: new Set(landed ? chain.map((s) => String(s.cell)) : []),
          weights: new Map(landed ? chain.map((s): [string, number] => [String(s.cell), 1]) : []),
          by: DETECTOR, deadline: false, ...(landed ? {} : { refused: "no_change" }),
        })
      }
      since = c.seq
      open = []
    }
  }
  return out
}

// A closure's chain (the treated selections it would credit) matters only to a closure that landed: a refused one
// credits no cell, and its readers (foldFrom keeps landed closures only; tally counts written, counted and refused) read
// no chain of it. Whether it landed depends on a few rows only: the rule's own tool's ended calls before the closure,
// each checked against the closure's window and open gap rows through its own selection. So that is decided first, and
// the chain is gathered only for a closure that landed (database: 22 closures, none landed, each scanning 15,079
// selections and ~8.8 M refs, 4-5 s of every posterior). The same grades as gapClosuresScan, which the tests hold it to.
// How many chains gapClosuresOf has gathered (one per landed closure), read by the tests to count the work, not time it.
let chainsGathered = 0
export const gapChainsGathered = (): number => chainsGathered
// The scan over every treated selection a landed closure's chain costs: counted where it is made.
const gather = (sels: Row[], inChain: (s: Row | undefined) => s is Row): Row[] => { chainsGathered++; return sels.filter(inChain) }
const gapClosuresOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const rule = seen.filter((r) => r.shape === CREDITS && r.role === OWNER && String(r.target) === GAP).sort((a, b) => a.seq - b.seq).at(-1)
  const by = typeof rule?.by_call === "string" && rule.by_call !== "" ? rule.by_call : undefined
  if (by === undefined) return []
  const sels = new Map(seen.filter((r) => r.shape === SELECTION && String(r.arm) === TREATED).map((r) => [r.id, r]))
  const failed = new Set(seen
    .filter(moveFailed(seen))
    .map((r) => String(r.selection_ref)))
  const started = new Map(seen.filter((r) => r.shape === HOP && r.role === WALK && r.phase === "started" && r.pointer_type === by)
    .map((r) => [String(r.call_id), r]))
  const ended = seen.filter((r) => r.shape === HOP && r.role === WALK && r.phase === "ended" && started.has(String(r.call_id)))
  const out: Grade[] = []
  const byGap = new Map<string, Row[]>()
  for (const r of seen.filter((x) => x.shape === GAP && x.role === DETECTOR && x.gap_id !== undefined).sort((a, b) => a.seq - b.seq)) {
    if (!byGap.has(String(r.gap_id))) byGap.set(String(r.gap_id), [])
    byGap.get(String(r.gap_id))!.push(r)
  }
  for (const rows of byGap.values()) {
    let since = 0
    let open: string[] = []
    for (const c of rows) {
      if (c.status === "open") { open.push(c.id); continue }
      if (open.length > 0 && c.seq <= asOf) {
        const held = (s: Row) => [s.pool_refs, s.input_refs].flat().map(String).some((id) => open.includes(id))
        const inChain = (s: Row | undefined): s is Row => s !== undefined && s.seq > since && s.seq < c.seq && held(s) && !failed.has(s.id)
        const landed = ended.some((e) => e.seq < c.seq && inChain(sels.get(String(started.get(String(e.call_id))?.selection_ref))))
        const chain = landed ? gather([...sels.values()], inChain) : []
        out.push({
          id: c.id, ok: landed, r: 1, judged: c.id, key: `gap|${c.id}`, cells: new Set(landed ? chain.map((s) => String(s.cell)) : []),
          weights: new Map(landed ? chain.map((s): [string, number] => [String(s.cell), 1]) : []),
          by: DETECTOR, deadline: false, ...(landed ? {} : { refused: "no_change" }),
        })
      }
      since = c.seq
      open = []
    }
  }
  return out
}

// A cell is the move and everything it saw ("<move>|<context>": the shapes, the asker, the age), so the same cell
// rarely comes twice and most draws were made at the prior: nothing learned carried to the next request. A cell with no
// counted evidence of its own backs off to a coarser one that has some: the same move for the same asker, then the same
// move anywhere, then any move of its kind. The finest level with evidence answers, each grade counted once, and the answer says which (from).
// An owner prior still belongs to the exact cell.
// A PROMISE IS SETTLED BY WHAT THE WALK DID NEXT (enablement-credit design §12.1; the USER: "Credit kept, penalise
// broken"). On a root whose latest change_wanted says wanted: true, an answer may promise its next act: next_act
// {tool, target}, a field of its schema, never read from prose. The root's next N selections after the answer (N: the
// owner's promise_window) settle it:
//   - kept: one of them did that act: a call of that tool (its started hop's pointer_type) whose request's pointer names
//     the target (a pointer field equal to it, or a path ending in /target: loose, on purpose), or a run of a template
//     with such a call: r 1, when the tool is an act (the owner's requires rows gate it on a wanted change); a kept
//     promise of anything else earns nothing. A call that starts and is then refused or cut is still kept; its own
//     failure is graded as a move (moveFailures);
//   - broken: N of the root's selections passed and none was such a call: r 0;
//   - neither yet (fewer than N have passed), or the root has no wanted: true: no grade.
// Only the walk's own call hops count; an answer or described row naming the act is no evidence. The grade judges the
// selection that produced the answer, and travels back along consumption like any other origination (foldFrom), at
// the owner's w_check. With no promise weight and window on the credits row, nothing is settled.
const promiseGradesOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const t = travelOf(seen)
  if (t?.promise_window === undefined || t.w_check === undefined) return []
  const n = t.promise_window
  // Built once per call: rows by id, each root's selections in order, each root's change_wanted judgments in order.
  const byId = new Map(seen.map((r) => [r.id, r]))
  const byRoot = new Map<string, Row[]>()
  for (const x of seen.filter((r) => r.shape === SELECTION).sort((a, b) => a.seq - b.seq)) {
    if (typeof x.root !== "string") continue
    if (!byRoot.has(x.root)) byRoot.set(x.root, [])
    byRoot.get(x.root)!.push(x)
  }
  const wantedRows = new Map<string, Row[]>()
  for (const w of seen.filter((r) => r.shape === "change_wanted").sort((a, b) => a.seq - b.seq)) {
    for (const root of [w.input_refs].flat().map(String)) {
      if (!wantedRows.has(root)) wantedRows.set(root, [])
      wantedRows.get(root)!.push(w)
    }
  }
  const wanted = (root: string, before: number): boolean => (wantedRows.get(root) ?? []).filter((w) => w.seq < before).at(-1)?.wanted === true
  // Which tools are acts: the ones the owner's requires rows gate on a wanted change (the owner's word, read here, not
  // a list in records). Keeping a promise of anything else earns nothing; breaking one is still broken.
  const acts = new Set(seen.filter((r) => r.shape === "requires" && r.role === OWNER && r.needs === "change_wanted" && r.retired !== true).map((r) => String(r.for)))
  // Each selection's started calls, by the tool called (a run's inner calls each write their own started hop under the
  // run's selection, so a run can have several).
  const started = new Map<string, Set<string>>()
  for (const h of seen.filter((r) => r.shape === HOP && r.role === WALK && r.phase === "started")) {
    const k = String(h.selection_ref)
    if (!started.has(k)) started.set(k, new Set())
    started.get(k)!.add(String(h.pointer_type))
  }
  // The target matches loosely, on purpose: any string field of the call's pointer equal to it, or a path ending in
  // /target (the clone's absolute path ends in the repository's relative one).
  const names = (pointer: unknown, target: string): boolean => typeof pointer === "object" && pointer !== null
    && Object.values(pointer as Record<string, unknown>).some((v) => typeof v === "string" && (v === target || v.endsWith(`/${target}`)))
  // Whether a selection did the promised act: a call of that tool actually started under it (the walk's started hop),
  // with the target named by the call's pointer: a call's request pointer, or, for a run (which has no request), its
  // template's declared call of that tool. A run whose template declares the act but which stopped before that call
  // started did not do it.
  const did = (x: Row, tool: string, target: string): boolean => {
    if (!started.get(x.id)?.has(tool)) return false
    const a = String(x.a ?? "")
    if (a.startsWith("run/")) {
      const calls = byId.get(a.slice("run/".length))?.calls
      return Array.isArray(calls) && calls.some((c) => typeof c === "object" && c !== null && (c as Row).shape === tool && names((c as Row).pointer, target))
    }
    return names(byId.get(String(x.from))?.pointer, target)
  }
  let index: Index | undefined
  const idx = (): Index => (index ??= indexAt(all, atSeq))
  const failed = new Set(seen.filter(moveFailed(seen)).map((r) => String(r.selection_ref)))
  // A PROMISE THE WALK COULD NOT KEEP BECAUSE THE REQUEST WAITED ON A PERSON counts for nothing (the USER, 11-16: "No
  // lapse while waiting", carried to promises: the window measured the person's time, not the makers'). Broken, and at
  // the selection that decided it a call on the root was waiting on a person (the walk's failure saying waits_for
  // person, its selection's root this root) with no person row about the root since: refused person_wait, no debit.
  const { waitingAt } = personWait(seen, byId)
  const out: Grade[] = []
  for (const a of seen.filter((r) => r.shape === "answer" && r.role === DESCRIBED && r.seq <= asOf)) {
    const act = a.next_act as { tool?: unknown; target?: unknown } | undefined
    if (typeof act !== "object" || act === null || typeof act.tool !== "string" || typeof act.target !== "string") continue
    const s = byId.get(String(a.selection_ref))
    const root = typeof s?.root === "string" ? s.root : undefined
    if (s === undefined || s.shape !== SELECTION || root === undefined || String(s.arm) !== TREATED || !wanted(root, a.seq)) continue
    const window = (byRoot.get(root) ?? []).filter((x) => x.seq > a.seq).slice(0, n)
    const kept = window.find((x) => did(x, String(act.tool), String(act.target)))
    const decided = kept ?? (window.length === n ? window[n - 1] : undefined)
    if (decided === undefined || decided.seq > asOf) continue
    if (kept !== undefined && !acts.has(String(act.tool))) continue // a kept promise of a non-act earns nothing
    const r = kept !== undefined ? 1 : 0
    if (r === 0 && waitingAt(root, decided.seq)) {
      out.push({ id: a.id, ok: false, r, judged: s.id, key: `promise|${a.id}`, cells: new Set(), weights: new Map(), by: "promise", deadline: false, refused: "person_wait" })
      continue
    }
    const weights = new Map<string, number>()
    for (const [id, g] of reached(idx(), s.id, t, { by: "promise", r })) {
      const x = byId.get(id)
      if (x === undefined || x.shape !== SELECTION || String(x.arm) !== TREATED || failed.has(id)) continue
      weights.set(String(x.cell), Math.max(weights.get(String(x.cell)) ?? 0, g))
    }
    out.push({ id: a.id, ok: true, r, judged: s.id, key: `promise|${a.id}`, cells: new Set(weights.keys()), weights, by: "promise", deadline: false })
  }
  return out
}

// GRADES ARE COMPUTED ONCE PER (asOf, atSeq) OVER ONE ROW LIST. The posterior a walk reads, its tally, closing,
// lapses and each outcome's standing all ask the same grades of the same rows: computed apart, each read redid the
// whole fold. The rows are append-only, so an answer for a list holds while the list's length is unchanged; the cache
// is per list (a test's own list is its own), holds a few (asOf, atSeq) pairs, and is the fold's own answer kept, not
// state of its own: nothing is persisted or served, and what it returns is what the computation returns (V2 below).
// Callers must not change what it returns (none does: they filter and map).
// Each fold a cache miss ran (which fold, over how many rows, how long), since the last drain: a request's handler drains
// it to say what its answer cost (index.ts). Nothing reads it to decide anything.
export type Refold = { fold: string; rows: number; ms: number }
let refolds: Refold[] = []
export const drainRefolds = (): Refold[] => { const out = refolds; refolds = []; return out }
// A derivation kept the same way outside the fold (store.ts's ask states) says its miss here too.
export const noteRefold = (r: Refold): void => { refolds.push(r) }

const memo = (f: (all: Row[], asOf: number, atSeq: number) => Grade[]) => {
  const byList = new WeakMap<Row[], { n: number; at: Map<string, Grade[]> }>()
  return (all: Row[], asOf: number, atSeq: number): Grade[] => {
    let c = byList.get(all)
    if (c === undefined || c.n !== all.length) { c = { n: all.length, at: new Map() }; byList.set(all, c) }
    const k = `${asOf}|${atSeq}`
    const hit = c.at.get(k)
    if (hit !== undefined) return hit
    const t0 = performance.now()
    const v = f(all, asOf, atSeq)
    refolds.push({ fold: f.name, rows: all.length, ms: Math.round(performance.now() - t0) })
    if (c.at.size >= 8) c.at.delete(c.at.keys().next().value as string)
    c.at.set(k, v)
    return v
  }
}
export const grades = memo(gradesOf)
export const moveFailures = memo(moveFailuresOf)
export const gapClosures = memo(gapClosuresOf)
export const promiseGrades = memo(promiseGradesOf)

// A person's verdict on a landing teaches the steps that produced the change (the USER, 11-15 ~12:15Z: "Yes, credit the
// chain (Recommended)"). A person's land_verdict r 0 or 1 grades the treated selection that made the gitDiff it judges
// (the walk's git_diff call), and travels back along consumption at w_person·γ^k, as a person's grade of an answer does:
// so the edits and commits behind the diff are credited or debited. Only a person's: a model's land_verdict originates
// nothing here (model grades are judged by the cross-grade rule at git_land). One standing grade per person per tree: a
// later verdict of theirs on the same tree replaces the earlier.
// The shapes this fold takes grades from: a model's or a person's judgment of a step, not a step that made anything.
const GRADE_SHAPES = new Set([OUTCOME, LAND_VERDICT])
const landGradesOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const t = travelOf(seen)
  if (t === undefined) return [] // no owner credits row: nothing travels, so nothing is credited
  const byId = new Map(seen.map((r) => [r.id, r]))
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const failed = new Set(seen.filter(moveFailed(seen)).map((r) => String(r.selection_ref)))
  let index: Index | undefined
  const idx = (): Index => (index ??= indexAt(all, atSeq))
  const out = new Map<string, Grade>()
  for (const v of seen.filter((r) => r.shape === LAND_VERDICT && r.role === PERSON && r.seq <= asOf).sort((a, b) => a.seq - b.seq)) {
    const r = Number(v.r)
    if (!(r === 0 || r === 1)) continue
    const diff = [v.input_refs].flat().map((id) => byId.get(String(id))).find((x) => x !== undefined && x.shape === GIT_DIFF && x.role === WALK)
    const made = diff === undefined ? undefined : sels.get(String(diff.selection_ref))
    if (made === undefined || String(made.arm) !== TREATED) continue
    // As at the landing (git_land): a Right counts only on the whole diff the person was shown; a Wrong on any.
    if (r === 1 && diff!.truncated === true) continue
    // A verdict judges the tree it names: one citing a diff of another tree judges nothing here.
    if (String(v.tree) !== String(diff!.tree)) continue
    const weights = new Map<string, number>()
    // The USER (~16:00Z): "Stop at makers": a landing teaches the steps that made the change, never the graders whose
    // grades a maker read. A grade row (a shape this fold takes grades from) is not walked through: its producer is
    // judged by later person marks on what it graded.
    for (const [id, g] of reached(idx(), made.id, t, { by: PERSON, r }, (row) => GRADE_SHAPES.has(String(row.shape)))) {
      const x = byId.get(id)
      if (x === undefined || x.shape !== SELECTION || String(x.arm) !== TREATED || failed.has(id)) continue
      weights.set(String(x.cell), Math.max(weights.get(String(x.cell)) ?? 0, g))
    }
    // The USER (~16:00Z): "Latest decides": as at the landing, only the latest person mark on a tree counts, whoever made
    // it: one standing land grade per tree (verdicts are read in seq order, so the latest replaces the earlier).
    const key = `land|${String(diff!.tree ?? diff!.id)}`
    out.set(key, { id: v.id, ok: true, r, judged: made.id, key, cells: new Set(weights.keys()), weights, by: PERSON, deadline: false })
  }
  return [...out.values()]
}
// USE: a move's output that another move takes as input earns; one nobody takes costs. At the owner's w_check, on the
// cell of the selection judged:
//   - used: within the owner's promise_window (the root's next N selections, of any arm, as a promise's window counts
//     them), an unfailed selection of a DIFFERENT move consumed (consumedOf, the rows reached() walks) a row one of that
//     move's selections produced → r 1, once per request and move, on the cell of the first of its selections so used.
//     A call selection cites none of the rows it worked on: it took p's output when it is a call of one of the calls
//     offered on p's output, at or after that offer, within the window. Such a take counts whether the taker then failed
//     or not (a refused take counts as used), as the walk offered the output and the taker took it; its failure is
//     charged through its own chain. A failed selection that only cites the output, unoffered, is no use: a failed
//     use counts only on the offer path.
//     A move's own later steps never count, so a move cannot earn by feeding itself, and a loop between two moves earns
//     each one once: counted per take, two moves feeding each other would earn without end;
//   - unused: N of the root's selections passed after one of its selections, nothing took it, and a consumer of it was
//     offered within them → r 0, once per such selection: each output nobody took is its own failure, so four idle runs
//     of one move cost four, and a use of the move elsewhere on the request does not undo it. Offered: a later selection
//     of the root within the window had a row this selection made as its frontier (the root's newest made row, which the
//     walk writes on each selection) with calls that take it. An output no consumer was offered for is not its
//     producer's miss but the walk's offer, which the missed-step gap reports, so it is not debited; nor is one judged
//     on selections that carry no frontier;
//   - otherwise (no window passed yet, or no consumer offered) → no grade.
// Judged: treated, unfailed selections with a root that produced something: calls and runs (their tool answers), and
// produces none of whose rows is a grade (a grader is judged by the marks on what it graded) or a deadline (a deadline
// is judged by its lapse). A selection that made a promise is judged by the promise rule alone, the stronger
// owner-gated signal, not twice: counted, or refused by that rule's own exemptions (a request waiting on a person is
// not debited by its promise, so not by its use either). With no promise weight and window on the credits row, nothing
// is judged.
const useGradesOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const t = travelOf(seen)
  if (t?.promise_window === undefined || t.w_check === undefined) return []
  const n = t.promise_window, w = t.w_check
  const index = indexAt(all, atSeq)
  const consumed = consumedOf(index)
  const { byId, sels, made, failed } = index
  const promised = new Set(promiseGrades(all, asOf, atSeq).map((k) => k.judged))
  const byRoot = new Map<string, Row[]>()
  const pos = new Map<string, number>()
  const ordered = [...sels.values()].sort((a, b) => a.seq - b.seq)
  for (const s of ordered) {
    if (typeof s.root !== "string") continue
    if (!byRoot.has(s.root)) byRoot.set(s.root, [])
    pos.set(s.id, byRoot.get(s.root)!.length)
    byRoot.get(s.root)!.push(s)
  }
  const judged = (s: Row): boolean => {
    if (String(s.arm) !== TREATED || typeof s.root !== "string" || failed.has(s.id) || promised.has(s.id)) return false
    const a = String(s.a ?? "")
    if (a.startsWith("call/") || a.startsWith("run/")) return true
    const m = made.get(s.id) ?? []
    return m.length > 0 && m.every((r) => !GRADE_SHAPES.has(String(r.shape)) && !isDeadline(r))
  }
  // The selections within p's window that offered its output: their frontier a row p made, with calls that take it.
  const offersOf = (p: Row): Row[] => {
    const i = pos.get(p.id)!
    return byRoot.get(String(p.root))!.slice(i + 1, i + 1 + n).filter((c) => {
      const f = c.frontier as Row | undefined
      return typeof f?.id === "string" && byId.get(f.id)?.selection_ref === p.id && Array.isArray(c.calls) && c.calls.length > 0
    })
  }
  const offered = (p: Row): boolean => offersOf(p).length > 0
  const used = new Set<string>()
  for (const c of sels.values()) {
    if (failed.has(c.id) || c.seq > asOf || typeof c.root !== "string") continue
    for (const x of consumed(c)) {
      const p = sels.get(String(byId.get(x)?.selection_ref))
      if (p === undefined || p.root !== c.root || move(String(p.cell)) === move(String(c.cell))) continue
      const i = pos.get(p.id), j = pos.get(c.id)
      if (i === undefined || j === undefined || j <= i || j > i + n) continue
      used.add(p.id)
    }
  }
  // A call selection cites none of the rows it worked on, so its take is read from the offer: a call of the root, of
  // another move, at or after an offer of p's output and within p's window, whose call is one of the calls on that offer.
  // Matched by the call's kind, not by row: rows between the offer and the call (an explanation, a newer output) move
  // the root's frontier on, and the call says no row it took.
  for (const p of ordered) {
    if (typeof p.root !== "string") continue
    const i = pos.get(p.id)!, line = byRoot.get(p.root)!
    for (const o of offersOf(p)) {
      const calls = (o.calls as unknown[]).map(String)
      if (line.slice(pos.get(o.id)!, i + 1 + n).some((c) => {
        const a = String(c.a ?? "")
        return c.seq <= asOf && a.startsWith("call/") && calls.includes(a.slice(5)) && move(String(c.cell)) !== move(String(p.cell))
      })) used.add(p.id)
    }
  }
  const out = new Map<string, Grade>()
  for (const p of ordered) {
    // (a take or a passed window is read as of asOf below, so a selection past it earns and costs nothing)
    if (!judged(p)) continue
    const cell = String(p.cell)
    if (used.has(p.id)) {
      const key = `use|${String(p.root)}|${move(cell)}`
      if (!out.has(key)) out.set(key, { id: `use:${p.id}`, ok: true, r: 1, judged: p.id, key, cells: new Set([cell]), weights: new Map([[cell, w]]), by: "use", deadline: false })
      continue
    }
    const last = byRoot.get(String(p.root))![pos.get(p.id)! + n]
    if (last === undefined || last.seq > asOf || !offered(p)) continue
    const key = `unused|${p.id}`
    out.set(key, { id: `unused:${p.id}`, ok: true, r: 0, judged: p.id, key, cells: new Set([cell]), weights: new Map([[cell, w]]), by: "use", deadline: false })
  }
  return [...out.values()]
}
export const useGrades = memo(useGradesOf)
export const landGrades = memo(landGradesOf)
// The same, computed fresh: what a check compares the kept answers with.
export const fresh = { grades: gradesOf, moveFailures: moveFailuresOf, gapClosures: gapClosuresOf, promiseGrades: promiseGradesOf, landGrades: landGradesOf, useGrades: useGradesOf }

type Level = "cell" | "asker" | "move" | "kind" | "none"
const move = (c: string): string => c.split("|")[0]
// A move's kind: its first segment, as the walk names its moves ("run/<template>", "produce/<shape>/...", "call/<shape>").
// Found without split, so a read splits each cell no more often than before.
const head = (x: string, sep: string): string => { const i = x.indexOf(sep); return i < 0 ? x : x.slice(0, i) }
const kindOf = (c: string): string => head(head(c, "|"), "/")
const asker = (c: string): string | undefined => c.split("|").slice(1).join("|").split(",").find((t) => t.startsWith("asker:"))
// A cell's move and asker, as move() and asker() give them: what foldFrom splits each cell string into, once per read.
export const cellParts = (c: string): { move: string; asker: string | undefined } => ({ move: move(c), asker: asker(c) })

export const foldFrom = (all: Row[], cells: string[], asOf: number, atSeq: number): Array<Post & { from: Level }> => {
  const priors = all.filter((r) => r.seq <= atSeq).filter((r) => r.shape === PRIOR).filter((r) => r.role === OWNER)
  const closures = gapClosures(all, asOf, atSeq).filter((k) => k.ok)
  // Credit originates only at a person's verdict or a lapse (r 0 on a passed deadline, however records wrote it, the
  // walk's own lapse rows included), each at its owner weight, and at a closure. The walk's own described grade of its
  // answer is a model judging an outcome: it stays a row (closing and lapse detection read it) but originates nothing.
  const t = travelOf(all.filter((r) => r.seq <= atSeq))
  const scale = (k: Grade, w: number): Grade => ({ ...k, weights: new Map([...k.weights].map(([c, g]) => [c, g * w])) })
  const by = (k: Grade, w: "w_person" | "w_lapse" | "w_close"): Grade => t === undefined ? k : scale(k, t[w])
  const originated = standing(all, asOf, atSeq).flatMap((k) =>
    k.deadline && k.r === 0 ? [by(k, "w_lapse")] : k.by === PERSON ? [by(k, "w_person")] : [])
  const promised = t?.w_check === undefined ? [] : promiseGrades(all, asOf, atSeq).map((k) => scale(k, t.w_check as number))
  const landed = landGrades(all, asOf, atSeq).map((k) => by(k, "w_person"))
  const latest = [...new Map([...originated, ...moveFailures(all, asOf, atSeq), ...closures.map((k) => by(k, "w_close")), ...promised, ...landed, ...useGrades(all, asOf, atSeq)].map((k) => [k.key, k])).values()]
  // EACH CELL STRING IS SPLIT ONCE PER READ, AND THE GRADES ARE INDEXED ONCE PER READ: by cell, by move, and by move and
  // asker, here in this call and kept by nothing after it (the next read's grades may differ). Each index lists a grade
  // once, at its place in latest, so every level below selects the grades a filter of latest selected, in the same
  // order, and each sum adds them in that order (a floating point sum depends on it). A queried cell is split only when
  // some grade has a cell, as the levels' comparisons split it only then.
  const parts = new Map<string, { move: string; asker: string | undefined; kind: string }>()
  const part = (x: string): { move: string; asker: string | undefined; kind: string } => {
    let p = parts.get(x)
    if (p === undefined) { p = { ...cellParts(x), kind: kindOf(x) }; parts.set(x, p) }
    return p
  }
  const byCell = new Map<string, Grade[]>()
  const byMove = new Map<string, Grade[]>()
  const byKind = new Map<string, Grade[]>()
  const byAsker = new Map<string, Map<string, Grade[]>>()
  const list = <K>(m: Map<K, Grade[]>, key: K, k: Grade): void => {
    const l = m.get(key)
    if (l === undefined) m.set(key, [k])
    else if (l[l.length - 1] !== k) l.push(k)
  }
  for (const k of latest) {
    for (const x of k.weights.keys()) part(x)
    for (const x of k.cells) {
      const p = part(x)
      list(byCell, x, k)
      list(byMove, p.move, k)
      list(byKind, p.kind, k)
      if (p.asker === undefined) continue
      if (!byAsker.has(p.move)) byAsker.set(p.move, new Map())
      list(byAsker.get(p.move)!, p.asker, k)
    }
  }
  // The owner's start for a move no level has a record for, indexed once per read as the grades are: the latest prior
  // row for each kind, and the latest default.
  const kindPrior = new Map<string, Row>()
  let defaultPrior: Row | undefined
  for (const r of priors) {
    if (typeof r.kind === "string") kindPrior.set(r.kind, r)
    if (r.default === true) defaultPrior = r
  }
  const anyCell = latest.some((k) => k.cells.size > 0)
  if (anyCell) for (const c of cells) part(c)
  return cells.map((c) => {
    const pc = anyCell ? parts.get(c) : undefined
    const levels: Array<[Level, (x: string) => boolean]> = [
      ["cell", (x) => x === c],
      ["asker", (x) => parts.get(x)!.move === pc!.move && pc!.asker !== undefined && parts.get(x)!.asker === pc!.asker],
      ["move", (x) => parts.get(x)!.move === pc!.move],
      ["kind", (x) => parts.get(x)!.kind === pc!.kind],
    ]
    const own = priors.filter((r) => String(r.cell) === c)
    const p0 = own.reduce((_, r) => ({ alpha: Number(r.alpha0), beta: Number(r.beta0) }), { alpha: 1, beta: 1 })
    // Each grade's weight at a level: its largest weight on a cell that level matches.
    const w = (k: Grade, level: Level): number => Math.max(0, ...[...k.weights].filter(([x]) => levels.find(([l]) => l === level)![1](x)).map(([, g]) => g))
    const sum = (ks: Grade[], level: Level) => ({
      wins: ks.reduce((s, k) => s + k.r * w(k, level), 0), losses: ks.reduce((s, k) => s + (1 - k.r) * w(k, level), 0) })
    // INHERIT, THEN REFINE (the USER, 11-15). The levels nest: a cell starts from the record of the finest coarser level
    // that has one, counted without the grades that reach this cell itself (they are added once, as its own), and its
    // own grades add on top. So a new cell's first grade adds to what it inherited instead of replacing it: a move that
    // failed seventeen times in a coarser context does not draw as new after one more ("never forgets"). The owner may
    // cap how much is inherited (prior_count on the credits row: the inherited record then weighs at most that many
    // grades); with no cap the whole record is inherited. An owner prior on the exact cell is the owner's word and is
    // kept as the prior instead.
    const mine = byCell.get(c) ?? []
    const ownSet = new Set(mine)
    const others = (ks: Grade[] | undefined): Grade[] => (ks ?? []).filter((k) => !ownSet.has(k))
    const at: Array<[Level, () => Grade[]]> = [
      ["asker", () => pc === undefined || pc.asker === undefined ? [] : others(byAsker.get(pc.move)?.get(pc.asker))],
      ["move", () => pc === undefined ? [] : others(byMove.get(pc.move))],
      ["kind", () => pc === undefined || mine.length > 0 ? [] : others(byKind.get(pc.kind))],
    ]
    const [coarse, inherited] = at.map(([level, ks]): [Level, Grade[]] => [level, ks()]).find(([, ks]) => ks.length > 0) ?? ["none" as Level, []]
    const got = sum(inherited, coarse)
    const cap = t?.prior_count
    const scale = cap === undefined ? 1 : Math.min(1, cap / Math.max(got.wins + got.losses, 1e-9))
    // A MOVE NEVER GRADED STARTS FROM ITS KIND'S RECORD, ELSE THE OWNER'S WORD (USER ruling 11-23, a never-run move starts
    // from its kind's record, else the owner's p0). A cell with no grades of its own whose move has none at the asker or
    // move level takes its kind's record (the last level above); with none, the owner's prior row for its kind (prior
    // {kind, alpha0, beta0}), else the owner's default (prior {default: true, alpha0, beta0}), the latest of each. A 1/1
    // drawn for every move never tried outdrew every move with a record (most of them mostly failure), so untried moves
    // won nearly every draw. A cell with grades of its own is a move that has run: it inherits as before, and neither its
    // kind's record nor the owner's start reaches it. With no owner row at all the start is 1/1, as before.
    // A query cell that is not a string has no kind; only the default can start it.
    const start = (): { alpha: number; beta: number } => {
      const r = (typeof c === "string" ? kindPrior.get(kindOf(c)) : undefined) ?? defaultPrior
      return r === undefined ? p0 : { alpha: Number(r.alpha0), beta: Number(r.beta0) }
    }
    const base = own.length > 0 ? p0 : coarse === "none" && mine.length === 0 ? start() : { alpha: p0.alpha + got.wins * scale, beta: p0.beta + got.losses * scale }
    const self = sum(mine, "cell")
    return { cell: c, alpha: base.alpha + self.wins, beta: base.beta + self.losses, from: mine.length > 0 ? "cell" : coarse }
  })
}

export const fold = (all: Row[], cells: string[], asOf: number, atSeq: number): Post[] =>
  foldFrom(all, cells, asOf, atSeq).map(({ cell, alpha, beta }) => ({ cell, alpha, beta }))

// V1: A SELECTION'S POSTERIOR IS THE FOLD'S, REFOLDED FROM THE ROWS. A selection records the posterior it drew its
// chosen cell from (posts, in its cands' order) and the sequence number records answered at (posts_seq); the walk asked
// with its arm row's as_of_seq. Refolding that cell from the rows at that point must give the same alpha and beta: a
// kept answer (the memo above, or any later shortcut) that drifted from the rows shows here. Returns each mismatch
// (an empty list when every sampled selection agrees). Selections that do not say enough to refold are skipped and
// counted, so a check that read nothing does not pass as one that agreed.
export type V1 = { checked: number; skipped: number; mismatches: Array<{ selection: string; cell: string; recorded: Post; refolded: Post }> }
export const verifySelections = (all: Row[], sample: Row[]): V1 => {
  const out: V1 = { checked: 0, skipped: 0, mismatches: [] }
  const arms = all.filter((r) => r.shape === ARM)
  for (const s of sample) {
    const cands = Array.isArray(s.cands) ? (s.cands as Array<{ id?: unknown; root?: unknown }>) : []
    const posts = Array.isArray(s.posts) ? (s.posts as Array<{ alpha?: unknown; beta?: unknown }>) : []
    const j = cands.findIndex((c) => c.id === s.a && (s.root === undefined || c.root === s.root))
    const arm = arms.filter((r) => r.seq < s.seq && r.vessel_id === s.writer).at(-1)
    const at = Number(s.posts_seq)
    if (s.shape !== SELECTION || typeof s.cell !== "string" || j < 0 || posts[j] === undefined || arm === undefined || !Number.isFinite(at)) {
      out.skipped++; continue
    }
    const recorded = { cell: s.cell, alpha: Number(posts[j].alpha), beta: Number(posts[j].beta) }
    const [p] = foldFrom(all, [s.cell], Number(arm.as_of_seq), at)
    const refolded = { cell: s.cell, alpha: p.alpha, beta: p.beta }
    out.checked++
    if (Math.abs(refolded.alpha - recorded.alpha) > 1e-9 || Math.abs(refolded.beta - recorded.beta) > 1e-9) out.mismatches.push({ selection: s.id, cell: s.cell, recorded, refolded })
  }
  return out
}

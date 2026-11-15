// SPDX-License-Identifier: MIT
import { ACTIVITY_TEMPLATE, ARM, CREDITS, DESCRIBED, DETECTOR, FAILURE, GAP, GIT_DIFF, HOP, LAND_VERDICT, OPERATOR, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, SHAPE_SCHEMA, TREATED, WALK } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

// Rows a grade may take as given evidence: what a person, the owner or an operator asked or said. Only a person's grade
// is a verdict (GRADERS, and the o.role === PERSON checks below): an operator's grade counts for nothing.
const GIVEN = new Set([PERSON, OWNER, OPERATOR])
const GRADERS = new Set([DESCRIBED, PERSON])

// by: the grader's role (person, or described for the walk's own outcome); deadline: the judged row is a deadline, so
// a counted grade of it at r 0 is a lapse.
// refused: why a grade does not count, when it does not (the first reason that applies).
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
export type Index = { byId: Map<string, Row>; sels: Map<string, Row>; made: Map<string, Row[]>; inputs: Map<string, Set<string>> }
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
  return { byId, sels, made, inputs }
}

export const reached = (index: Index, start: string, t: Travel): Map<string, number> => {
  const { byId, sels, made, inputs } = index
  const consumed = (sel: Row): string[] => {
    const a = String(sel.a ?? "")
    if (a.startsWith("call/")) return sel.from === undefined ? [] : [String(sel.from)]
    if (a.startsWith("run/")) return [a.slice("run/".length)]
    return (made.get(sel.id) ?? []).flatMap((p) => {
      const shown = new Set([p.input_refs].flat().map(String))
      const ins = inputs.get(String(p.shape)) ?? new Set<string>()
      const asInput = [...shown].filter((id) => ins.has(String(byId.get(id)?.shape)))
      const used = [p.uses ?? []].flat().map(String).filter((id) => shown.has(id))
      return [...asInput, ...used]
    })
  }
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
        const p = byId.get(x)?.selection_ref
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
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const treated = (id: unknown): boolean => String(sels.get(String(id))?.arm) === TREATED
  // A selection whose move failed (a failure row the walk that made it wrote, whatever the status or kind) produced
  // nothing a grade can be crediting, so it is left out of every chain. A skip row is not such a failure: it names a
  // template that could not run, and cites whichever selection the walk was making then, not a move of its own.
  const failed = new Set(seen
    .filter((r) => r.shape === FAILURE && r.role === WALK && r.kind !== "skip")
    .filter((r) => sels.get(String(r.selection_ref))?.writer === r.writer)
    .map((r) => String(r.selection_ref)))
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
  const idx = (): Index => (index ??= indexOf(seen))
  const given = (r: Row): boolean => (entries ?? []).some((e) => typeof e === "object" && e !== null && "where" in e && matches(r, e))
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
      : o.role !== PERSON && !(clean || lapse) ? "unclean"
      : !timely ? "untimely"
      : undefined
    const ok = refused === undefined
    // What it credits: the selection that made the judged row, and every selection whose output that one consumed,
    // back along consumption (reached), each once at w·gamma^k for its shortest distance k. Never the pool it saw.
    const weights = new Map<string, number>()
    if (ok && s !== undefined) {
      for (const [id, g] of travel === undefined ? new Map([[s.id, 1]]) : reached(idx(), s.id, travel)) {
        if (!treated(id) || failed.has(id)) continue
        const c = String(sels.get(id)?.cell)
        weights.set(c, Math.max(weights.get(c) ?? 0, g))
      }
    }
    return { id: o.id, ok, r, judged: String(judged[0]?.id), key: [o.writer, judged[0]?.id].join("|"), cells: new Set(weights.keys()), weights, by: String(o.role), deadline, ...(refused ? { refused } : {}) }
  }
  return seen
    .filter((r) => r.shape === OUTCOME)
    .filter((r) => GRADERS.has(r.role))
    .filter((r) => r.seq <= asOf)
    .map(credit)
}

// How the walk's own grades (described outcomes) fared, over every one written: how many were written and how many
// counted, of answers and of deadlines (lapses) apart, and why the rest did not count. A detector reads it to see grades
// being written that the fold never counts. Cumulative: a reader compares two of these to see what changed between.
// A detector's closing of a gap (gapClosures) is tallied as a kind of its own, so a credit path that never counts (written,
// none counted) shows.
export type Tally = { written: { answer: number; lapse: number; detector: number }; counted: { answer: number; lapse: number; detector: number }; refused: Record<string, number> }
export const tally = (all: Row[], asOf: number, atSeq: number): Tally => {
  const t: Tally = { written: { answer: 0, lapse: 0, detector: 0 }, counted: { answer: 0, lapse: 0, detector: 0 }, refused: {} }
  for (const g of [...grades(all, asOf, atSeq).filter((x) => x.by === DESCRIBED), ...gapClosures(all, asOf, atSeq)]) {
    const kind = g.by === DETECTOR ? "detector" : g.deadline ? "lapse" : "answer"
    t.written[kind]++
    if (g.ok) t.counted[kind]++
    else t.refused[g.refused ?? "other"] = (t.refused[g.refused ?? "other"] ?? 0) + 1
  }
  return t
}

// The grades that stand: those that count, and of each writer's grades of one answer only the latest (a repeat
// replaces, never adds), as the fold below folds them. A person who grades an answer r 1 and then r 0 has not closed it.
export const standing = (all: Row[], asOf: number, atSeq: number): Grade[] =>
  [...new Map(grades(all, asOf, atSeq).filter((k) => k.ok).map((k) => [k.key, k])).values()]

// Whom a move's failure blames, decided once, here, and stamped on the failure row when it is written (store.ts), so
// every reader (this fold, and the walk deciding whether to call the same pointer again) reads one answer:
//   request: the vessel called answered and refused what was asked: a 200 carrying an error, or a 4xx other than
//            401/403 (the caller's credentials, which rotate) and 408/429 (the callee was busy);
//   callee:  anything else, an outage, a timeout or a transport error: not the move's fault;
//   walk:    the walk declined to run or record it (a kind of its own: skip, too_big, unrunnable).
// A refusal the walk recorded as waiting for a person (waits_for: "person" on the failure row, lifted from git_land's
// answer: the change touches what judges changes, and only a person's verdict lands it) is the gate working, not a
// fault in what was asked: callee. Read from the row's field only, never from its body.
const NOT_THE_REQUEST = new Set([401, 403, 408, 429])
export const blames = (f: Record<string, unknown>): "request" | "callee" | "walk" => {
  if (f.kind !== undefined) return "walk"
  if (f.waits_for === "person") return "callee"
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
const moveFailuresOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const byId = new Map(seen.map((r) => [r.id, r]))
  const out = new Map<string, Grade>()
  for (const f of seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.seq <= asOf)) {
    const s = sels.get(String(f.selection_ref))
    if (s === undefined || String(s.arm) !== TREATED || s.writer !== f.writer) continue
    if (blamed(f) !== "request") continue
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
const gapClosuresOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const rule = seen.filter((r) => r.shape === CREDITS && r.role === OWNER && String(r.target) === GAP).sort((a, b) => a.seq - b.seq).at(-1)
  const by = typeof rule?.by_call === "string" && rule.by_call !== "" ? rule.by_call : undefined
  if (by === undefined) return []
  const sels = seen.filter((r) => r.shape === SELECTION && String(r.arm) === TREATED)
  const failed = new Set(seen
    .filter((r) => r.shape === FAILURE && r.role === WALK && r.kind !== "skip")
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

// A cell is the move and everything it saw ("<move>|<context>": the shapes, the asker, the age), so the same cell
// rarely comes twice and most draws were made at the prior: nothing learned carried to the next request. A cell with no
// counted evidence of its own backs off to a coarser one that has some: the same move for the same asker, then the same
// move anywhere. The finest level with evidence answers, each grade counted once, and the answer says which (from).
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
  const idx = (): Index => (index ??= indexOf(seen))
  const failed = new Set(seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.kind !== "skip").map((r) => String(r.selection_ref)))
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
    const weights = new Map<string, number>()
    for (const [id, g] of reached(idx(), s.id, t)) {
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
const memo = (f: (all: Row[], asOf: number, atSeq: number) => Grade[]) => {
  const byList = new WeakMap<Row[], { n: number; at: Map<string, Grade[]> }>()
  return (all: Row[], asOf: number, atSeq: number): Grade[] => {
    let c = byList.get(all)
    if (c === undefined || c.n !== all.length) { c = { n: all.length, at: new Map() }; byList.set(all, c) }
    const k = `${asOf}|${atSeq}`
    const hit = c.at.get(k)
    if (hit !== undefined) return hit
    const v = f(all, asOf, atSeq)
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
const landGradesOf = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const t = travelOf(seen)
  if (t === undefined) return [] // no owner credits row: nothing travels, so nothing is credited
  const byId = new Map(seen.map((r) => [r.id, r]))
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const failed = new Set(seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.kind !== "skip").map((r) => String(r.selection_ref)))
  let index: Index | undefined
  const idx = (): Index => (index ??= indexOf(seen))
  const out = new Map<string, Grade>()
  for (const v of seen.filter((r) => r.shape === LAND_VERDICT && r.role === PERSON && r.seq <= asOf).sort((a, b) => a.seq - b.seq)) {
    const r = Number(v.r)
    if (!(r === 0 || r === 1)) continue
    const diff = [v.input_refs].flat().map((id) => byId.get(String(id))).find((x) => x !== undefined && x.shape === GIT_DIFF && x.role === WALK)
    const made = diff === undefined ? undefined : sels.get(String(diff.selection_ref))
    if (made === undefined || String(made.arm) !== TREATED) continue
    // As at the landing (git_land): a Right counts only on the whole diff the person was shown; a Wrong on any.
    if (r === 1 && diff!.truncated === true) continue
    const weights = new Map<string, number>()
    for (const [id, g] of reached(idx(), made.id, t)) {
      const x = byId.get(id)
      if (x === undefined || x.shape !== SELECTION || String(x.arm) !== TREATED || failed.has(id)) continue
      weights.set(String(x.cell), Math.max(weights.get(String(x.cell)) ?? 0, g))
    }
    const key = `land|${String(v.writer)}|${String(diff!.tree ?? diff!.id)}`
    out.set(key, { id: v.id, ok: true, r, judged: made.id, key, cells: new Set(weights.keys()), weights, by: PERSON, deadline: false })
  }
  return [...out.values()]
}
export const landGrades = memo(landGradesOf)
// The same, computed fresh: what a check compares the kept answers with.
export const fresh = { grades: gradesOf, moveFailures: moveFailuresOf, gapClosures: gapClosuresOf, promiseGrades: promiseGradesOf, landGrades: landGradesOf }

type Level = "cell" | "asker" | "move" | "none"
const move = (c: string): string => c.split("|")[0]
const asker = (c: string): string | undefined => c.split("|").slice(1).join("|").split(",").find((t) => t.startsWith("asker:"))

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
  const latest = [...new Map([...originated, ...moveFailures(all, asOf, atSeq), ...closures.map((k) => by(k, "w_close")), ...promised, ...landed].map((k) => [k.key, k])).values()]
  return cells.map((c) => {
    const levels: Array<[Level, (x: string) => boolean]> = [
      ["cell", (x) => x === c],
      ["asker", (x) => move(x) === move(c) && asker(c) !== undefined && asker(x) === asker(c)],
      ["move", (x) => move(x) === move(c)],
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
    const mine = latest.filter((k) => [...k.cells].some(levels[0][1]))
    const ownSet = new Set(mine)
    const others = latest.filter((k) => !ownSet.has(k))
    const [coarse, inherited] = levels.slice(1)
      .map(([level, at]): [Level, Grade[]] => [level, others.filter((k) => [...k.cells].some(at))])
      .find(([, ks]) => ks.length > 0) ?? ["none" as Level, []]
    const got = sum(inherited, coarse)
    const cap = t?.prior_count
    const scale = cap === undefined ? 1 : Math.min(1, cap / Math.max(got.wins + got.losses, 1e-9))
    const base = own.length > 0 ? p0 : { alpha: p0.alpha + got.wins * scale, beta: p0.beta + got.losses * scale }
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

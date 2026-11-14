// SPDX-License-Identifier: MIT
import { CREDITS, DESCRIBED, DETECTOR, FAILURE, GAP, HOP, OPERATOR, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, SHAPE_SCHEMA, TREATED, WALK } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

// Rows a grade may take as given evidence: what a person, the owner or an operator asked or said. Only a person's grade
// is a verdict (GRADERS, and the o.role === PERSON checks below): an operator's grade counts for nothing.
const GIVEN = new Set([PERSON, OWNER, OPERATOR])
const GRADERS = new Set([DESCRIBED, PERSON])

// by: the grader's role (person, or described for the walk's own outcome); deadline: the judged row is a deadline, so
// a counted grade of it at r 0 is a lapse.
// refused: why a grade does not count, when it does not (the first reason that applies).
export type Grade = { ok: boolean; r: number; judged: string; key: string; cells: Set<string>; weights: Map<string, number>; by: string; deadline: boolean; refused?: string }

// What the owner's credits row for target "selection" says about how credit travels: the weight each kind of
// origination carries, the discount per consumption edge (gamma) and how far it goes (depth). The row is the only
// source of these (design: enablement-credit section 1). With no row, or a row with any field missing or out of range
// (the row is then unusable whole, not patched field by field), nothing travels: a grade credits only the selection
// that made the row it judged, counted once, unscaled. Either is said on records' output, once per change.
export type Travel = { w_person: number; w_lapse: number; w_close: number; gamma: number; depth: number }
const BOUNDS: Record<keyof Travel, [number, number]> = { w_person: [0, 10], w_lapse: [0, 10], w_close: [0, 10], gamma: [0, 1], depth: [0, 64] }
let said = ""
const say = (line: string): void => {
  if (line !== said) console.log(`[records] ${line}`)
  said = line
}
const travelOf = (seen: Row[]): Travel | undefined => {
  const row = seen.filter((r) => r.shape === CREDITS && r.role === OWNER && String(r.target) === SELECTION).sort((a, b) => a.seq - b.seq).at(-1)
  if (row === undefined) { say("credits selection row absent: depth 0 only"); return undefined }
  const bad = (Object.keys(BOUNDS) as Array<keyof Travel>).find((k) => {
    const v = row[k]
    return typeof v !== "number" || !Number.isFinite(v) || v < BOUNDS[k][0] || v > BOUNDS[k][1] || (k === "depth" && !Number.isInteger(v))
  })
  const id = String(row.id).replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 64)
  if (bad !== undefined) { say(`credits selection row ${id} ignored: ${bad} missing or out of range; depth 0 only`); return undefined }
  say(`credits selection row ${id} used`)
  return { w_person: Number(row.w_person), w_lapse: Number(row.w_lapse), w_close: Number(row.w_close), gamma: Number(row.gamma), depth: Number(row.depth) }
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
export const grades = (all: Row[], asOf: number, atSeq: number): Grade[] => {
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
    return { ok, r, judged: String(judged[0]?.id), key: [o.writer, judged[0]?.id].join("|"), cells: new Set(weights.keys()), weights, by: String(o.role), deadline, ...(refused ? { refused } : {}) }
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
const NOT_THE_REQUEST = new Set([401, 403, 408, 429])
export const blames = (f: Record<string, unknown>): "request" | "callee" | "walk" => {
  if (f.kind !== undefined) return "walk"
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
export const moveFailures = (all: Row[], asOf: number, atSeq: number): Grade[] => {
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
    out.set(s.id, { ok: true, r: 0, judged: chose.id, key: `fail|${s.id}`, cells: new Set([String(chose.cell)]), weights: new Map([[String(chose.cell), 1]]), by: WALK, deadline: false })
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
export const gapClosures = (all: Row[], asOf: number, atSeq: number): Grade[] => {
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
          ok: landed, r: 1, judged: c.id, key: `gap|${c.id}`, cells: new Set(landed ? chain.map((s) => String(s.cell)) : []),
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
  const latest = [...new Map([...originated, ...moveFailures(all, asOf, atSeq), ...closures.map((k) => by(k, "w_close"))].map((k) => [k.key, k])).values()]
  return cells.map((c) => {
    const levels: Array<[Level, (x: string) => boolean]> = [
      ["cell", (x) => x === c],
      ["asker", (x) => move(x) === move(c) && asker(c) !== undefined && asker(x) === asker(c)],
      ["move", (x) => move(x) === move(c)],
    ]
    const [from, counted] = levels
      .map(([level, at]): [Level, Grade[]] => [level, latest.filter((k) => [...k.cells].some(at))])
      .find(([, ks]) => ks.length > 0) ?? ["none", []]
    const p0 = priors
      .filter((r) => String(r.cell) === c)
      .reduce((_, r) => ({ alpha: Number(r.alpha0), beta: Number(r.beta0) }), { alpha: 1, beta: 1 })
    // Each grade's weight at this level: its largest weight on a cell this level matches.
    const w = (k: Grade): number => Math.max(0, ...[...k.weights].filter(([x]) => levels.find(([l]) => l === from)![1](x)).map(([, g]) => g))
    const wins = counted.reduce((s, k) => s + k.r * w(k), 0)
    const losses = counted.reduce((s, k) => s + (1 - k.r) * w(k), 0)
    return { cell: c, alpha: p0.alpha + wins, beta: p0.beta + losses, from }
  })
}

export const fold = (all: Row[], cells: string[], asOf: number, atSeq: number): Post[] =>
  foldFrom(all, cells, asOf, atSeq).map(({ cell, alpha, beta }) => ({ cell, alpha, beta }))

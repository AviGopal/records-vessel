// SPDX-License-Identifier: MIT
// Stores for the posterior fold's tests (cellidx.test.ts), in the forms rows take when written (as episode-rows.ts makes
// them: input_refs defaulted, a deadline's `at` from its within_ms, seq, t on a fixed clock, writer, role, then the
// sha256 id), so the same builder gives the same rows every run.
//   levels: requests worked interleaved by a seeded generator, over many moves, askers and cell forms (a cell with no
//     asker, the asker tag first, in the middle or last), with consumption chains so one grade reaches several cells
//     (some of one move, some of one move and asker, at different weights), person grades, the walk's grader, lapses,
//     failures blaming the request, waits on a person, promises, a diff and a person's land verdict, gaps a detector
//     closes, the owner's credits row with prior_count (the inherited record capped) and owner priors on exact cells.
//   seps: cells holding the separators in unusual places, each graded.
//   order: three person grades reaching one cell at w_person·γ^k for k = 0, 1, 2, whose sum differs by the order it is
//     added in.
// queryOf(rows): the walk's posterior query over a store: every cell its selections and the owner's priors name, in first
// appearance, then cells no grade names (a new context of a graded move, an unseen asker, an unseen move), repeated in
// another order (a tick's options repeat cells).
import type { Row } from "../../src/store"

const T0 = Date.parse("2026-11-01T00:00:00.000Z")
type As = { writer: string; role: string }
const walk: As = { writer: "walk-1", role: "walk" }
const desc: As = { writer: "described-1", role: "described" }
const owner: As = { writer: "owner", role: "owner" }
const person: As = { writer: "kid-person", role: "person" }
const operator: As = { writer: "kid-operator", role: "operator" }
const detector: As = { writer: "pull-sync", role: "detector" }

const store = () => {
  const rows: Row[] = []
  const add = (body: Record<string, unknown>, as: As): Row => {
    const seq = rows.length + 1
    const t = new Date(T0 + seq * 1000).toISOString()
    const deadline = typeof body.within_ms === "number" ? { at: Date.parse(t) + body.within_ms } : {}
    const unsigned = { input_refs: [], ...body, ...deadline, seq, t, writer: as.writer, role: as.role }
    const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(unsigned)).digest("hex")
    const row = { ...unsigned, shape: String(body.shape), id } as Row
    rows.push(row)
    return row
  }
  const select = (root: string, pool: string[], a: string, cell: string, more: Record<string, unknown> = {}): Row =>
    add({ shape: "selection", arm: "treated", cell, a, root, pool_refs: pool, input_refs: pool, posts_seq: rows.length, ...more }, walk)
  const hop = (sel: Row, call: string, phase: "started" | "ended", type: string, more: Record<string, unknown> = {}): Row =>
    add({ shape: "hop", phase, call_id: call, pointer_type: type, kind: "call", selection_ref: sel.id, ...(phase === "ended" ? { output: { ok: true, call } } : {}), ...more }, walk)
  return { rows, add, select, hop }
}

const schemas = (add: ReturnType<typeof store>["add"]): void => {
  add({ shape: "shape_schema", target: "plan", inputs: ["world_changed"] }, owner)
  add({ shape: "shape_schema", target: "finding", inputs: ["world_changed", "plan", { shape: "hop" }] }, owner)
  add({ shape: "shape_schema", target: "answer", inputs: ["world_changed", "plan", "finding"], fields: { text: "string" } }, owner)
}

export const levels = (): Row[] => {
  const { rows, add, select, hop } = store()
  let state = 0x2545f491
  const rand = (): number => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32 }
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!
  // one move's cell in one of the forms the walk has written: the asker last, first, in the middle, or no asker at all
  const cellOf = (a: string, asker: string, n: number): string => {
    const k = rand()
    return k < 0.4 ? `${a}|asker:${asker},shapes:${n}` : k < 0.6 ? `${a}|world_changed,asker:${asker},age:${n % 3}`
      : k < 0.8 ? `${a}|shapes:${n},asker:${asker}` : `${a}|shapes:${n}`
  }
  add({ shape: "arm", vessel_id: "walk-1", arm: "treated", as_of_seq: 1e9 }, owner)
  add({ shape: "credits", target: "selection", w_person: 0.9, w_lapse: 1.1, w_close: 0.6, gamma: 0.7, depth: 12, w_check: 0.5, promise_window: 4, prior_count: 3 }, owner)
  add({ shape: "credits", target: "gap", by_call: "git_land" }, owner)
  schemas(add)
  add({ shape: "shape_schema", target: "outcome", inputs: ["world_changed"], context: ["answer", "due", { shape: "hop", where: { phase: "ended" } }],
    evidence: [{ shape: "answer", deferred_by: "next_act" }], schema: { "x-reach": { from: "targets", field: "targets" } } }, owner)
  add({ shape: "requires", call: "git_land", for: "git_land", needs: "change_wanted" }, owner)
  // the owner's priors on exact cells: some the walk's selections name, one it never does
  for (const [i, c] of ["produce/plan|asker:person,shapes:1", "produce/answer|shapes:3", "judge|world_changed,asker:operator,age:2", "call/fs_read|asker:nobody,shapes:9"].entries())
    add({ shape: "prior", cell: c, alpha0: 2, beta0: 1 + i }, owner)
  const asks: string[] = []
  function* request(i: number): Generator<void> {
    const asker = pick(["person", "operator", "person"])
    const ask = add({ shape: "world_changed", what: `ask ${i}` }, asker === "person" ? person : operator); asks.push(ask.id); yield
    const wants = rand() < 0.5
    if (wants) { add({ shape: "change_wanted", wanted: true, input_refs: [ask.id] }, desc); yield }
    const s0 = select(ask.id, [ask.id], "produce/due", cellOf("produce/due", asker, 1)); yield
    const due = add({ shape: "due", within_ms: rand() < 0.6 ? 60_000 : 86_400_000, selection_ref: s0.id, input_refs: [ask.id] }, desc); yield
    const s1 = select(ask.id, [ask.id], "produce/plan", cellOf("produce/plan", asker, 1)); yield
    hop(s1, `c${i}a`, "started", "fs_read"); yield
    const ended = hop(s1, `c${i}a`, "ended", "fs_read"); yield
    const plan = add({ shape: "plan", steps: 3, selection_ref: s1.id, input_refs: [ask.id, ended.id] }, desc); yield
    // a second plan by the same move: one grade then reaches two cells of one move (and often of one asker)
    const s1b = select(ask.id, [ask.id], "produce/plan", cellOf("produce/plan", asker, 2)); yield
    const plan2 = add({ shape: "plan", steps: 1, selection_ref: s1b.id, input_refs: [ask.id] }, desc); yield
    const s2 = select(ask.id, [ask.id, plan.id], "produce/finding", cellOf("produce/finding", asker, 2)); yield
    if (rand() < 0.3) { add({ shape: "failure", status: 422, call_id: `c${i}f`, selection_ref: s2.id, blames: "request" }, walk); yield }
    if (rand() < 0.25) {
      const sw = select(ask.id, [ask.id, plan.id], "call/git_land", cellOf("call/git_land", asker, 2)); yield
      hop(sw, `c${i}w`, "started", "git_land"); yield
      add({ shape: "failure", call_id: `c${i}w`, selection_ref: sw.id, status: 409, waits_for: "person", input_refs: [sw.id] }, walk); yield
      if (rand() < 0.5) { add({ shape: "note", text: "go ahead", input_refs: [ask.id] }, person); yield }
    }
    const finding = add({ shape: "finding", note: "x", selection_ref: s2.id, input_refs: [ask.id, plan.id] }, desc); yield
    const s3 = select(ask.id, [ask.id, plan.id, plan2.id, finding.id], "produce/answer", cellOf("produce/answer", asker, 3)); yield
    const promises = wants && rand() < 0.5
    const ans = add({ shape: "answer", text: `answer ${i}`, selection_ref: s3.id, input_refs: [ask.id, plan.id, plan2.id, finding.id],
      ...(promises ? { next_act: { tool: "git_land", target: `repos/x/src/f${i}.ts` } } : {}) }, desc); yield
    for (let k = 0; k < 4; k++) {
      if (rand() < 0.5) continue
      const a = pick(["call/fs_read", "call/git_land", "call/grep"])
      const sx = select(ask.id, [ask.id, ans.id], a, cellOf(a, asker, 2)); yield
      if (a === "call/git_land") { hop(sx, `c${i}l${k}`, "started", "git_land"); yield }
      if (rand() < 0.2) { add({ shape: "failure", status: 400, call_id: `c${i}x${k}`, selection_ref: sx.id, blames: "request" }, walk); yield }
    }
    if (rand() < 0.7) {
      const sj = select(ask.id, [ask.id, ans.id], "judge", cellOf("judge", asker, 2)); yield
      add({ shape: "outcome", r: rand() < 0.6 ? 1 : 0, selection_ref: sj.id, root: ask.id, input_refs: [ask.id, ans.id], evidence_refs: [ans.id] }, desc); yield
    }
    const later = rand()
    if (later < 0.45) { add({ shape: "outcome", r: rand() < 0.7 ? 1 : 0, input_refs: [ans.id] }, person); yield }
    else if (later < 0.6) { add({ shape: "outcome", r: 0, input_refs: [due.id] }, person); yield }
    if (wants && rand() < 0.6) {
      const sd = select(ask.id, [ask.id, ans.id], "call/git_diff", cellOf("call/git_diff", asker, 2)); yield
      hop(sd, `c${i}d`, "started", "git_diff"); yield
      const diff = add({ shape: "gitDiff", diff: "+x", tree: `tree${i}`, selection_ref: sd.id }, walk); yield
      hop(sd, `c${i}d`, "ended", "git_diff"); yield
      if (rand() < 0.7) { add({ shape: "land_verdict", r: rand() < 0.7 ? 1 : 0, tree: `tree${i}`, input_refs: [diff.id] }, person); yield }
    }
  }
  function* gap(i: number): Generator<void> {
    const g = add({ shape: "gap", gap_id: `g${i}`, status: "open", summary: "test fails" }, detector); yield
    const s = select(g.id, [g.id], "call/git_land", `call/git_land|asker:detector,shapes:${1 + (i % 2)}`); yield
    hop(s, `gl${i}`, "started", "git_land"); yield
    hop(s, `gl${i}`, "ended", "git_land"); yield
    add({ shape: "gap", gap_id: `g${i}`, status: "closed", summary: "passes" }, detector); yield
  }
  const active: Generator<void>[] = []
  let started = 0, gaps = 0
  while (started < 9 || active.length > 0) {
    while (active.length < 4 && started < 9) {
      active.push(request(started++))
      if (started % 3 === 0) active.push(gap(gaps++))
    }
    const j = Math.floor(rand() * active.length)
    if (active[j]!.next().done) active.splice(j, 1)
  }
  return rows
}

// Cells with the separators in unusual places (a leading, trailing or doubled "|", an empty asker tag, two asker tags, an
// asker tag holding "|", no "|" at all, the empty string, a "," before the "|"), each the cell of a selection whose move
// failed blaming the request (one r 0 on that cell), some also graded by a person through an answer.
export const SEPS = [
  "|asker:person", "call/x|", "call/x||asker:person", "call/x|asker:", "call/x|asker:a,asker:b", "call/x|asker:a|b",
  "call/x|world,asker:a|b,c", "call/x", "", "call/x|,asker:person,", "|", ",", "call/x|asker:person|asker:other",
  "call/x,asker:person|shapes:1", "asker:person", "call/x||", "call/x|asker:a", "call/x|shapes:1,asker:person",
]
export const seps = (): Row[] => {
  const { rows, add, select } = store()
  add({ shape: "arm", vessel_id: "walk-1", arm: "treated", as_of_seq: 1e9 }, owner)
  add({ shape: "credits", target: "selection", w_person: 0.9, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 }, owner)
  schemas(add)
  add({ shape: "prior", cell: "call/x|asker:", alpha0: 3, beta0: 2 }, owner)
  SEPS.forEach((cell, i) => {
    const ask = add({ shape: "world_changed", what: `ask ${i}` }, person)
    const s = select(ask.id, [ask.id], cell.split("|")[0]!, cell)
    add({ shape: "failure", status: 422, call_id: `f${i}`, selection_ref: s.id, blames: "request" }, walk)
    if (i % 3 === 0) {
      const plan = add({ shape: "plan", steps: 1, selection_ref: select(ask.id, [ask.id], "produce/plan", SEPS[(i + 5) % SEPS.length]!).id, input_refs: [ask.id] }, desc)
      const sa = select(ask.id, [ask.id, plan.id], "produce/answer", SEPS[(i + 2) % SEPS.length]!)
      const ans = add({ shape: "answer", text: `answer ${i}`, selection_ref: sa.id, input_refs: [ask.id, plan.id] }, desc)
      add({ shape: "outcome", r: i % 2, input_refs: [ans.id] }, person)
    }
  })
  return rows
}

// Three person grades of answers, each reaching the cell X: directly (k 0), through a plan (k 1), through a finding then
// a plan (k 2), at w_person 0.1, gamma 0.7. Their weights on X added in latest's order and in reverse give different
// floats; another cell of X's move and asker inherits all three.
export const ORDER_CELL = "produce/plan|asker:person,shapes:1"
export const ORDER_SIBLING = "produce/plan|asker:person,shapes:7"
export const order = (): Row[] => {
  const { rows, add, select } = store()
  add({ shape: "arm", vessel_id: "walk-1", arm: "treated", as_of_seq: 1e9 }, owner)
  add({ shape: "credits", target: "selection", w_person: 0.1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 }, owner)
  schemas(add)
  const ask = add({ shape: "world_changed", what: "one ask" }, person)
  const root = ask.id
  // k 0: an answer X's selection made
  const a0 = add({ shape: "answer", text: "a0", selection_ref: select(root, [root], "produce/plan", ORDER_CELL).id, input_refs: [root] }, desc)
  add({ shape: "outcome", r: 1, input_refs: [a0.id] }, person)
  // k 1: an answer consuming a plan X's selection made
  const p1 = add({ shape: "plan", steps: 1, selection_ref: select(root, [root], "produce/plan", ORDER_CELL).id, input_refs: [root] }, desc)
  const a1 = add({ shape: "answer", text: "a1", selection_ref: select(root, [root, p1.id], "produce/answer", "produce/answer|asker:person,shapes:2").id, input_refs: [root, p1.id] }, desc)
  add({ shape: "outcome", r: 1, input_refs: [a1.id] }, person)
  // k 2: an answer consuming a finding that consumed a plan X's selection made
  const p2 = add({ shape: "plan", steps: 1, selection_ref: select(root, [root], "produce/plan", ORDER_CELL).id, input_refs: [root] }, desc)
  const f2 = add({ shape: "finding", note: "f2", selection_ref: select(root, [root, p2.id], "produce/finding", "produce/finding|asker:person,shapes:2").id, input_refs: [root, p2.id] }, desc)
  const a2 = add({ shape: "answer", text: "a2", selection_ref: select(root, [root, f2.id], "produce/answer", "produce/answer|asker:person,shapes:3").id, input_refs: [root, f2.id] }, desc)
  add({ shape: "outcome", r: 1, input_refs: [a2.id] }, person)
  return rows
}

export const queryOf = (rows: Row[]): string[] => {
  const named: string[] = []
  for (const r of rows) {
    const c = r.shape === "selection" || r.shape === "prior" ? r.cell : undefined
    if (typeof c === "string" && !named.includes(c)) named.push(c)
  }
  const moves = [...new Set(named.map((c) => c.split("|")[0]!))]
  const probes = [...moves.flatMap((m) => [`${m}|asker:person,shapes:99`, `${m}|shapes:99`, `${m}|asker:unseen`, m]), "never/seen|asker:person", "never/seen", "|", ""]
  const once = [...named, ...probes.filter((c) => !named.includes(c))]
  return [...once, ...[...once].reverse().filter((_, i) => i % 2 === 0)]
}

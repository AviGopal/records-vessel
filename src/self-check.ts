// SPDX-License-Identifier: MIT
// THE SELF-CHECK: A COMPOSITION'S EXPECTATION MUST MOVE WHEN ITS MOVE FAILED OR WAS MADE AGAIN FOR NOTHING. A failure is
// owed to the move that failed and up the chain that fed it; a move offered again on its root with no act since its last
// choice is a repeat, and counts as a failure too (the USER's ruling on the detector's trigger). At the composition's
// next offer its expectation is compared with the one before: unmoved, the check files a gap about the composition; a
// later offer that moved closes it. It files gaps only: no score or credit is changed by it.
// Kept as rows arrive, never by a fold: the posteriors compared are the walk's own (each selection's posts, as records
// gave them at posts_seq), and a fold asked after a write would be a whole refold, since its memo is per row count.
// What the fold's own rules decide (which failures count, what a selection consumed) is read through the fold's own
// functions over an index kept the way indexOf builds it.
import { createHash } from "node:crypto"
import { indexOf, infraWindowsOf, moveFailedIn, reached, travelOf, type Index, type InfraWindow, type Travel } from "./fold"
import { CREDITS, DESCRIBED, DETECTOR, FAILURE, GAP, INFRA_WINDOW, OUTCOME, OWNER, SELECTION, SHAPE_SCHEMA, TREATED, WALK } from "./shapes"
import type { Row } from "./store"

export const SELF_CHECK = "self-check:"

type Post = { alpha: number; beta: number; from?: string }
type Offer = { sel: string; seq: number; posts_seq: number; post: Post; root: string }
type Owed = { failure: string; seq: number; failed_selection: string; owed_as: "own" | "chain"; before?: Offer; row: Row }
// unmoved opens a gap; moved (the expectation itself moved, whatever was done between) is all that closes one
export type Finding = { composition: string; trigger: "failure" | "repeat"; unmoved: boolean; moved: boolean; before: Offer; after: Offer; failure_ref?: string; failed_selection?: string; owed_as?: string; between?: string[] }

// A composition is a move in what it reads, asked by whom: its cell without the root's age, which only says how long the
// root has waited.
export const compositionOf = (cell: string): string => {
  const bar = cell.indexOf("|")
  if (bar < 0) return cell
  return `${cell.slice(0, bar)}|${cell.slice(bar + 1).split(",").filter((c) => !c.startsWith("age:")).join(",")}`
}
const shapeOf = (e: unknown): string => typeof e === "object" && e !== null ? String((e as { shape?: unknown }).shape) : String(e)
const mean = (p: Post): number => p.alpha / (p.alpha + p.beta)
// Unmoved: at the same level, no debit arrived (beta did not rise; alpha rising is credit, not a debit). At another level
// the two records are not one count, so their means are compared: unmoved if it did not fall.
export const unmoved = (before: Post, after: Post): boolean =>
  (before.from ?? "") === (after.from ?? "") ? after.beta <= before.beta : mean(after) >= mean(before)

// Every option a selection row offers, with the cell its posterior was asked for. A row written before options carried
// their context (walk a93a08d, cands[j].ctx) names only its chosen option's cell.
const offersOf = (s: Row): Array<Offer & { cell: string; chosen: boolean }> => {
  const cands = Array.isArray(s.cands) ? s.cands as Array<Record<string, unknown>> : []
  const posts = Array.isArray(s.posts) ? s.posts as Array<Record<string, unknown>> : []
  let chosenSeen = false
  return cands.flatMap((c, j) => {
    const p = posts[j]
    if (p === undefined || typeof p.alpha !== "number" || typeof p.beta !== "number") return []
    const isChosen = !chosenSeen && c.id === s.a && c.root === s.root
    if (isChosen) chosenSeen = true
    const cell = typeof c.ctx === "string" ? `${String(c.id)}|${c.ctx}` : isChosen ? String(s.cell) : undefined
    if (cell === undefined) return []
    const post: Post = { alpha: p.alpha, beta: p.beta, ...(typeof p.from === "string" ? { from: p.from } : {}) }
    return [{ sel: s.id, seq: s.seq, posts_seq: Number(s.posts_seq), post, root: String(c.root), cell, chosen: isChosen }]
  })
}

// `self` is the writer the detector's own gap rows carry: only those say which compositions it holds open, so another
// writer's row under the same gap ids cannot silence it.
export const checker = (self?: string) => {
  // The fold's index, kept as indexOf builds it (its parity is a leg).
  const index: Index = { byId: new Map(), sels: new Map(), made: new Map(), inputs: new Map(), failed: new Set() }
  const windowRows: Row[] = []
  let windows: InfraWindow[] = []
  const creditRows: Row[] = []
  let travel: Travel | undefined
  const walkFailures: Row[] = []
  const anyFailure = new Set<string>()
  const lastOffer = new Map<string, Offer>()
  const owed = new Map<string, Owed[]>()
  const lastChoice = new Map<string, Offer>()
  const acts = new Map<string, Array<{ sel: string; seq: number; k: string }>>()
  // an open gap, by the trigger that opened it
  const open = new Map<string, string>()

  const failedNow = (f: Row): boolean => moveFailedIn(windows)(f) && index.sels.get(String(f.selection_ref))?.writer === f.writer
  const refail = (): void => { index.failed = new Set(walkFailures.filter(failedNow).map((f) => String(f.selection_ref))) }

  const keep = (r: Row): void => {
    index.byId.set(r.id, r)
    if (r.shape === SELECTION) index.sels.set(r.id, r)
    if (typeof r.selection_ref === "string" && r.role === DESCRIBED && r.shape !== OUTCOME) {
      const list = index.made.get(r.selection_ref)
      if (list) list.push(r)
      else index.made.set(r.selection_ref, [r])
    }
    if (r.shape === SHAPE_SCHEMA && r.role === OWNER) {
      const k = String(r.target)
      index.inputs.set(k, new Set([...(index.inputs.get(k) ?? []), ...[r.inputs ?? []].flat().map(shapeOf)]))
    }
    if (r.shape === INFRA_WINDOW && r.role === OWNER) { windowRows.push(r); windows = infraWindowsOf(windowRows); refail() }
    if (r.shape === CREDITS && r.role === OWNER && String(r.target) === SELECTION) { creditRows.push(r); travel = travelOf(creditRows) }
    if (r.shape === FAILURE && r.role === WALK) {
      anyFailure.add(String(r.selection_ref))
      if (r.kind !== "skip") { walkFailures.push(r); if (failedNow(r)) index.failed.add(String(r.selection_ref)) }
    }
  }

  // A failure the fold counts is owed to its own move's composition and to each treated selection up the chain that fed
  // it, as far as the owner's credits row lets a debit travel (reached, at r 0: it crosses roots).
  // Whether a failure counts is read when it is judged (judge), since a window covers only rows written before it and so
  // arrives after the failure it excuses. A skip never counts, so it is not walked back here at all: a cost, not a rule.
  const owe = (f: Row): void => {
    if (f.kind === "skip") return
    const start = String(f.selection_ref)
    const s = index.sels.get(start)
    if (s === undefined || String(s.arm) !== TREATED || s.writer !== f.writer) return
    const chain = travel === undefined ? new Map([[start, 1]]) : reached(index, start, travel, { by: WALK, r: 0 })
    for (const id of chain.keys()) {
      const x = index.sels.get(id)
      if (x === undefined || String(x.arm) !== TREATED || x.role !== WALK || typeof x.cell !== "string") continue
      const k = compositionOf(x.cell)
      const list = owed.get(k) ?? []
      list.push({ failure: f.id, seq: f.seq, failed_selection: start, owed_as: id === start ? "own" : "chain", before: lastOffer.get(k), row: f })
      owed.set(k, list)
    }
  }

  // What a treated selection's offers show: for each composition offered, a failure owed to it since its offer before,
  // and a repeat of its last choice on the same root with no act between.
  const judge = (s: Row): Finding[] => {
    const out: Finding[] = []
    const offers = offersOf(s)
    for (const o of offers) {
      const k = compositionOf(o.cell)
      const after: Offer = { sel: o.sel, seq: o.seq, posts_seq: o.posts_seq, post: o.post, root: o.root }
      const pending = owed.get(k) ?? []
      const due = pending.filter((p) => o.posts_seq >= p.seq)
      if (due.length > 0) owed.set(k, pending.filter((p) => o.posts_seq < p.seq))
      for (const p of due) {
        if (p.before === undefined || !moveFailedIn(windows)(p.row)) continue
        out.push({ composition: k, trigger: "failure", unmoved: unmoved(p.before.post, o.post), moved: !unmoved(p.before.post, o.post), before: p.before, after, failure_ref: p.failure, failed_selection: p.failed_selection, owed_as: p.owed_as })
      }
      const c = lastChoice.get(`${o.root}|${k}`)
      if (c !== undefined) {
        const between = (acts.get(o.root) ?? []).filter((x) => x.seq > c.seq && x.seq < o.seq)
        const tried = between.some((x) => x.k !== k && !anyFailure.has(x.sel))
        out.push({ composition: k, trigger: "repeat", unmoved: !tried && unmoved(c.post, o.post), moved: !unmoved(c.post, o.post), before: c, after, between: between.map((x) => x.sel) })
      }
    }
    for (const o of offers) {
      const k = compositionOf(o.cell)
      const offer: Offer = { sel: o.sel, seq: o.seq, posts_seq: o.posts_seq, post: o.post, root: o.root }
      lastOffer.set(k, offer)
      if (!o.chosen) continue
      lastChoice.set(`${o.root}|${k}`, offer)
      const a = String(s.a ?? "")
      if (a.startsWith("call/") || a.startsWith("run/")) {
        const list = acts.get(o.root) ?? []
        list.push({ sel: s.id, seq: s.seq, k })
        acts.set(o.root, list)
      }
    }
    return out
  }

  // A gap per composition: opened by an unmoved finding, closed only when a later offer shows its expectation moved, with
  // none unmoved beside it. An act between choices keeps a repeat from opening a gap but closes none: a gap the walk
  // answered by doing something else on the root stays open until the composition's own expectation moves. Only a
  // change of state is written, so an open gap is not re-keyed on every repeat.
  const gapsOf = (found: Finding[]): Array<Record<string, unknown>> => {
    const by = new Map<string, Finding[]>()
    for (const f of found) by.set(f.composition, [...(by.get(f.composition) ?? []), f])
    const out: Array<Record<string, unknown>> = []
    for (const [k, fs] of by) {
      const stuck = fs.find((f) => f.unmoved)
      const openedBy = open.get(k)
      if (stuck !== undefined && openedBy === undefined) out.push(gapRow(k, "open", stuck))
      const moved = fs.find((f) => f.moved)
      if (stuck === undefined && moved !== undefined && openedBy !== undefined) out.push(gapRow(k, "closed", moved, openedBy))
    }
    return out
  }

  const see = (r: Row): Finding[] => {
    keep(r)
    if (r.shape === FAILURE && r.role === WALK) owe(r)
    if (r.shape === GAP && r.role === DETECTOR && (self === undefined || r.writer === self) && String(r.gap_id ?? "").startsWith(SELF_CHECK)) {
      const k = (r.meta as { composition?: unknown } | undefined)?.composition
      if (typeof k === "string") {
        if (r.status === "open") open.set(k, String((r.meta as { trigger?: unknown }).trigger ?? ""))
        else open.delete(k)
      }
    }
    if (r.shape === SELECTION && r.role === WALK && String(r.arm) === TREATED) return judge(r)
    return []
  }

  return { see, gapsOf, index }
}

export const gapIdOf = (composition: string): string => `${SELF_CHECK}${createHash("sha256").update(composition).digest("hex").slice(0, 16)}`

const gapRow = (k: string, status: "open" | "closed", f: Finding, openedBy?: string): Record<string, unknown> => ({
  shape: GAP,
  gap_id: gapIdOf(k),
  status,
  category: "self_check",
  summary: status === "open"
    ? `${k}: ${f.trigger === "failure" ? "a failure" : "a repeat with no act since its last choice"} was not reflected in its expectation at its next offer`
    : `${k}: its expectation moved at its next offer`,
  input_refs: [f.after.sel, f.before.sel, ...(f.failure_ref !== undefined ? [f.failure_ref] : [])],
  meta: {
    composition: k, trigger: f.trigger,
    // a close is judged by a later finding, whose trigger may not be the one that opened the gap
    ...(openedBy !== undefined ? { opened_by: openedBy } : {}),
    // the root the option was offered on, which a selection that chose another root's option does not name
    before: { selection: f.before.sel, root: f.before.root, ...f.before.post, posts_seq: f.before.posts_seq },
    after: { selection: f.after.sel, root: f.after.root, ...f.after.post, posts_seq: f.after.posts_seq },
    ...(f.failure_ref !== undefined ? { failure_ref: f.failure_ref, failed_selection: f.failed_selection, owed_as: f.owed_as } : {}),
    ...(f.between !== undefined ? { between: f.between } : {}),
  },
})

// Over a whole list of rows (the replay): every finding, unmoved or not, in seq order, up to atSeq.
export const selfCheck = (rows: Row[], atSeq = Number.POSITIVE_INFINITY): Finding[] => {
  const c = checker()
  return [...rows].filter((r) => r.seq <= atSeq).sort((a, b) => a.seq - b.seq).flatMap((r) => c.see(r))
}
// Exported for the parity leg: the index kept as rows arrive must equal the fold's own over the same rows.
export const parityOf = (rows: Row[]): { kept: Index; built: Index } => {
  const c = checker()
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) c.see(r)
  return { kept: c.index, built: indexOf(rows) }
}

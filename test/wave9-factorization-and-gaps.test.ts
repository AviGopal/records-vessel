// SPDX-License-Identifier: MIT
// Wave 9A invariants in records-vessel (D1, D2, D4):
//   1. Context factorization: episode-deduplicated (episode, target) grades, EB counterfactual lift, and
//      closerRed/test_verdict non-poisoning prevent 0/2254 horizon-mixing distortion.
//   2. Leaf-only isolation on recovered wrong-step-at-wrong-time failures (no move/asker/kind bucket poisoning).
//   3. Premature `request { none }` abandonment debit on open actionable gaps (and no debit when closed or held).
//   4. Repo-scoped openGaps filtering against non-retired owner repository rows with non-empty branch (D4).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as F from "../src/fold"
import type { Row } from "../src/store"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const WALK = "walk-test"
const owner = { writer: "owner", role: "owner" }
const detector = { writer: "det-test", role: "detector" }

const mkRows = () => {
  let seq = 0
  const rows: Row[] = []
  const T0 = Date.parse("2099-02-01T00:00:00Z")
  const add = (shape: string, role: string, fields: Record<string, unknown>, at = seq * 1000): Row => {
    const r = { shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields } as Row
    rows.push(r)
    return r
  }
  return { rows, add }
}

describe("Wave 9A — context|* EB counterfactual lift, deduplication & closerRed isolation", () => {
  test("[MUST-FAIL] test_verdict closes and unlanded closerRed polls do NOT poison context|request|gap", () => {
    const { rows, add } = mkRows()
    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 })
    add("credits", "owner", { target: "gap", by_call: "git_land" })

    // Failing_test gap with 20 closerRed open polls and 50 request steps, eventually closed via named_tests_pass (test_verdict)
    const gTest = add("gap", "detector", { gap_id: "ft-1", status: "open", category: "failing_test", meta: { closer_evidence: { count: "2 fail" } } })
    for (let i = 0; i < 50; i++) {
      const s = add("selection", "walk", { arm: "treated", root: gTest.id, a: "produce/request/ch1", cell: "produce/request/ch1|gap" })
      add("request", "described", { selection_ref: s.id, input_refs: [gTest.id], uses: [gTest.id], pointer: { type: "fs_read" } })
      if (i % 5 === 0) add("gap", "detector", { gap_id: "ft-1", status: "open", category: "failing_test", meta: { closer_evidence: { count: "2 fail" } } })
    }
    add("gap", "detector", { gap_id: "ft-1", status: "closed", category: "failing_test", closed_reason: "named_tests_pass" })

    // One unrelated failing person ask that used fooOnce (0/1) vs one winning ask (1/1)
    const aLose = add("world_changed", "person", { what: "lose" })
    const foo = add("fileContent", "walk", { path: "f.ts" })
    const sL = add("selection", "walk", { arm: "treated", root: aLose.id, a: "produce/request/ch1", cell: "produce/request/ch1|ask" })
    add("request", "described", { selection_ref: sL.id, input_refs: [aLose.id, foo.id], uses: [foo.id], pointer: { type: "fs_edit" } })
    const ansL = add("answer", "described", { selection_ref: add("selection", "walk", { arm: "treated", root: aLose.id, a: "produce/answer/ch1", cell: "produce/answer/ch1|ask" }).id, input_refs: [aLose.id] })
    add("outcome", "person", { r: 0, input_refs: [aLose.id, ansL.id] })

    const head = rows[rows.length - 1]!.seq
    const [pGap, pFoo] = F.foldFrom(rows, ["context|request|gap", "context|request|fileContent"], head, head)
    // Closed test_verdict gap with only unlanded closerRed polls stays neutral prior (1/1, from="none")
    expect(pGap).toEqual({ cell: "context|request|gap", alpha: 1, beta: 1, from: "none" })
    expect(pFoo!.from).toBe("cell")
  })

  test("[MUST-FAIL] multi-step retry episode is deduplicated to 1 observation per (episode, target) and EB counterfactual lift avoids crushing universal-fail horizons", () => {
    const { rows, add } = mkRows()
    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 })

    // Ask 1: 40 failing retries citing gap
    const a1 = add("world_changed", "person", { what: "ep1" })
    const gRef = add("gap", "detector", { gap_id: "gref", status: "open" })
    for (let i = 0; i < 40; i++) {
      const s = add("selection", "walk", { arm: "treated", root: a1.id, a: "produce/request/ch1", cell: "produce/request/ch1|ask" })
      add("request", "described", { selection_ref: s.id, input_refs: [a1.id, gRef.id], uses: [gRef.id], pointer: { type: "fs_read" } })
    }
    const ans1 = add("answer", "described", { selection_ref: add("selection", "walk", { arm: "treated", root: a1.id, a: "produce/answer/ch1", cell: "produce/answer/ch1|ask" }).id, input_refs: [a1.id] })
    add("outcome", "person", { r: 0, input_refs: [a1.id, ans1.id] })

    // Ask 2 & Ask 3: 1 step each citing gitDiff and both succeed (r=1)
    for (const n of [2, 3]) {
      const a = add("world_changed", "person", { what: `ep${n}` })
      const d = add("gitDiff", "walk", { diff: `+${n}` })
      const s = add("selection", "walk", { arm: "treated", root: a.id, a: "produce/request/ch1", cell: "produce/request/ch1|ask" })
      add("request", "described", { selection_ref: s.id, input_refs: [a.id, d.id], uses: [d.id], pointer: { type: "git_land" } })
      const ans = add("answer", "described", { selection_ref: add("selection", "walk", { arm: "treated", root: a.id, a: "produce/answer/ch1", cell: "produce/answer/ch1|ask" }).id, input_refs: [a.id] })
      add("outcome", "person", { r: 1, input_refs: [a.id, ans.id] })
    }

    const head = rows[rows.length - 1]!.seq
    const [pGap, pDiff] = F.foldFrom(rows, ["context|request|gap", "context|request|gitDiff"], head, head)
    // Deduplicated to 1 failing episode -> eff = n_s(1) + m(2) = 3, NOT 42!
    expect(pGap!.alpha + pGap!.beta).toBeCloseTo(3, 9)
    expect(pDiff!.alpha + pDiff!.beta).toBeCloseTo(4, 9)
    const mGap = pGap!.alpha / (pGap!.alpha + pGap!.beta)
    const mDiff = pDiff!.alpha / (pDiff!.alpha + pDiff!.beta)
    expect(mDiff).toBeGreaterThan(0.5)
    expect(mGap).toBeLessThan(0.5)
  })
})

describe("Wave 9A — leafOnly isolation & premature request { none } debit", () => {
  test("[MUST-FAIL] recovered wrong-step-at-wrong-time failure stays isolated to exact leaf cell without poisoning move/asker/kind", () => {
    const { rows, add } = mkRows()
    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 })

    const g = add("gap", "detector", { gap_id: "g-rec", status: "open", repo: "walk-vessel" })
    const wrongReqSel = add("selection", "walk", { arm: "treated", root: g.id, a: "produce/request/ch1", cell: "produce/request/ch1|gap,did:none,asker:detector,age:0" })
    const wrongReq = add("request", "described", { selection_ref: wrongReqSel.id, input_refs: [g.id], pointer: { type: "git_diff", cwd: "/trees/w" } })
    const wrongDiffSel = add("selection", "walk", { arm: "treated", root: g.id, a: "call/git_diff", from: wrongReq.id, cell: "call/git_diff|gap,did:none,asker:detector,age:0" })
    add("failure", "walk", { selection_ref: wrongDiffSel.id, status: 400, blames: "request", body: "nothing committed yet" })

    // Later on the same root, commit happens and call/git_diff succeeds without failing
    const rightReqSel = add("selection", "walk", { arm: "treated", root: g.id, a: "produce/request/ch1", cell: "produce/request/ch1|gap,did:git_commit,asker:detector,age:5" })
    const rightReq = add("request", "described", { selection_ref: rightReqSel.id, input_refs: [g.id], pointer: { type: "git_diff", cwd: "/trees/w" } })
    add("selection", "walk", { arm: "treated", root: g.id, a: "call/git_diff", from: rightReq.id, cell: "call/git_diff|gap,did:git_commit,asker:detector,age:5" })

    const head = rows[rows.length - 1]!.seq
    const fails = F.moveFailures(rows, head, head)
    expect(fails.find((k) => k.key === `fail|${wrongDiffSel.id}`)?.leafOnly).toBe(true)

    const [pBadLeaf, pOtherContext, pKind] = F.foldFrom(rows, [
      "produce/request/ch1|gap,did:none,asker:detector,age:0",
      "produce/request/ch1|gap,did:git_commit,asker:detector,age:5",
      "produce/due/ch1|gap,asker:detector,age:5",
    ], head, head)
    // Exact leaf cell took the debit
    expect(pBadLeaf).toEqual({ cell: "produce/request/ch1|gap,did:none,asker:detector,age:0", alpha: 1, beta: 2, from: "cell" })
    // Coarser buckets (sibling state of same move/asker & same kind) were NOT poisoned!
    expect(pOtherContext).toEqual({ cell: "produce/request/ch1|gap,did:git_commit,asker:detector,age:5", alpha: 1, beta: 1, from: "none" })
    expect(pKind).toEqual({ cell: "produce/due/ch1|gap,asker:detector,age:5", alpha: 1, beta: 1, from: "none" })
  })

  test("[MUST-FAIL] premature request { none } on an open actionable gap is debited, while held or closed gaps are not", () => {
    const { rows, add } = mkRows()
    const gOpen = add("gap", "detector", { gap_id: "g-open", status: "open", category: "failing_test" })
    const sAbandon = add("selection", "walk", { arm: "treated", root: gOpen.id, a: "produce/request/ch1", cell: "produce/request/ch1|gap,asker:detector" })
    add("request", "described", { selection_ref: sAbandon.id, input_refs: [gOpen.id], none: "cannot act" })

    const gHeld = add("gap", "detector", { gap_id: "g-held", status: "open", walkable: false })
    const sHeld = add("selection", "walk", { arm: "treated", root: gHeld.id, a: "produce/request/ch1", cell: "produce/request/ch1|held" })
    add("request", "described", { selection_ref: sHeld.id, input_refs: [gHeld.id], none: "not walkable" })

    const gClosed = add("gap", "detector", { gap_id: "g-done", status: "open" })
    add("gap", "detector", { gap_id: "g-done", status: "closed" })
    const sClosed = add("selection", "walk", { arm: "treated", root: gClosed.id, a: "produce/request/ch1", cell: "produce/request/ch1|closed" })
    add("request", "described", { selection_ref: sClosed.id, input_refs: [gClosed.id], none: "already closed" })

    const head = rows[rows.length - 1]!.seq
    const fails = F.moveFailures(rows, head, head)
    expect(fails.map((k) => k.key)).toEqual([`none|${sAbandon.id}`])
    const [pAbandon] = F.foldFrom(rows, ["produce/request/ch1|gap,asker:detector"], head, head)
    expect(pAbandon).toEqual({ cell: "produce/request/ch1|gap,asker:detector", alpha: 1, beta: 2, from: "cell" })
  })
})

describe("Wave 9A — D4 owner repository filter on openGaps", () => {
  let stop = () => {}
  afterEach(() => stop())

  test("[MUST-FAIL] excludes unowned unit-less repo gaps (ias-executor-ts) once owner repository rows with branch exist, while keeping super and live repos", async () => {
    const discovery: Fake = fake((path) => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
    const identity: Fake = fake(() => Response.json({ success: false }, { status: 401 }))
    const dir = mkdtempSync(join(tmpdir(), "records-w9-d4-"))
    const port = freePort()
    const vessel = run("src/index.ts", {
      RECORDS_VESSEL_ID: "records-w9-d4", RECORDS_PORT: String(port), DISCOVERY_URL: discovery.url,
      RECORDS_ENDPOINT: `http://127.0.0.1:${port}`, RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
    })
    stop = () => { vessel.kill(); discovery.stop(); identity.stop(); rmSync(dir, { recursive: true, force: true }) }
    await healthy(port)
    await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")

    const write = (row: object, as: { writer: string; role: string }) => fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: "record_write", row, ...as } } }),
    }).then((r) => r.json() as Promise<any>)
    const roots = () => fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: "record_read", episode: WALK, roots: "all" } } }),
    }).then((r) => r.json() as Promise<{ roots: Array<{ root: { gap_id?: string } }> }>)

    await write({ shape: "arm", vessel_id: WALK, arm: "treated" }, owner)
    // Open gaps for live repo, unit-less repo (ias-executor-ts), retired repo, super, and repo-less gap
    await write({ shape: "gap", gap_id: "g-live", status: "open", repo: "walk-vessel" }, detector)
    await write({ shape: "gap", gap_id: "g-unitless", status: "open", repo: "ias-executor-ts" }, detector)
    await write({ shape: "gap", gap_id: "g-retired", status: "open", repo: "analysis-vessel" }, detector)
    await write({ shape: "gap", gap_id: "g-super", status: "open", repo: "super" }, detector)
    await write({ shape: "gap", gap_id: "g-repoless", status: "open", category: "walk_failure" }, detector)

    // Before any owner repository row with branch exists: all 5 stay open (preserves isolated unit tests)
    expect((await roots()).roots.map((r) => r.root.gap_id)).toEqual(["g-live", "g-unitless", "g-retired", "g-super", "g-repoless"])

    // Seed owner repository rows matching vessels.inventory.json
    await write({ shape: "repository", repo: "walk-vessel", units: ["walk-vessel.service"], roles: ["walker"], retired: false, branch: "dev" }, owner)
    await write({ shape: "repository", repo: "analysis-vessel", units: ["analysis-vessel.service"], roles: ["compute"], retired: true, branch: "dev" }, owner)

    expect((await roots()).roots.map((r) => r.root.gap_id)).toEqual(["g-live", "g-super", "g-repoless"])
  })
})

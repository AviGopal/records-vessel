// SPDX-License-Identifier: MIT
// Wave 10B invariants in records-vessel (D2–D5):
//   1. Hierarchical `root:` Empirical Bayes posteriors (none -> kind -> asker -> cell), canonical gap_id episode inheritance,
//      and zero interference with normal move/cell/kind/asker posteriors.
//   2. Clean abstention: `request { none }` on a gap settled by `change_wanted { wanted: false }` is NOT debited as `none|<sel>`.
//   3. Structural earned-template quarantine (`isCleanEarnedTemplate`), negative-lift retirement (`n>=6, ub90<0.40`),
//      signature dedup, proven uncapped vs fresh `MAX_FRESH_TEMPLATES=8` cap in `shared(w)`.
//   4. `graduationGapsOf` `walkable: true` and persistence-gated `topologyExpansionGapsOf` (headroom-gated, `>=3` roots, closes when covered).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as F from "../src/fold"
import { GRADUATE_PREFIX, TOPOLOGY_PREFIX, graduationGapsOf, topologyExpansionGapsOf } from "../src/self-check"
import type { Row } from "../src/store"

const WALK = "walk-test"
const mkRows = () => {
  let seq = 0
  const rows: Row[] = []
  const T0 = Date.parse("2099-03-01T00:00:00Z")
  const add = (shape: string, role: string, fields: Record<string, unknown>, at = seq * 1000): Row => {
    const r = { shape, role, writer: role === "walk" ? WALK : role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields } as Row
    rows.push(r)
    return r
  }
  return { rows, add }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe("Wave 10B — root: posteriors, clean abstention, template quarantine & topology expansion", () => {
  test("[MUST-FAIL] hierarchical root: posteriors back off none -> kind -> asker -> cell and inherit across same gap_id", () => {
    const { rows, add } = mkRows()
    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 })

    // Unseen cell starts at prior (1, 1) from "none"
    const [unseen] = F.foldFrom(rows, ["root:world_changed|asker:person,id:missing"], rows.length, rows.length)
    expect(unseen.from).toBe("none")
    expect(unseen.alpha).toBe(1)
    expect(unseen.beta).toBe(1)

    // Add 4 failing detector gap roots + 1 closing detector gap root
    for (let i = 1; i <= 4; i++) {
      const g = add("gap", "detector", { gap_id: `wf-${i}`, status: "open", category: "walk_failure" })
      const sel = add("selection", "walk", { arm: "treated", a: "produce/request/gap", cell: "produce/request/gap|asker:detector", root: g.id, pool_refs: [g.id] })
      add("failure", "walk", { kind: undefined, blamed: "request", blames: "request", selection_ref: sel.id, root: g.id })
    }
    const gClosed = add("gap", "detector", { gap_id: "wf-closed", status: "open", category: "failing_test" })
    const sClosed = add("selection", "walk", { arm: "treated", a: "call/git_land", cell: "call/git_land|asker:detector", root: gClosed.id, pool_refs: [gClosed.id] })
    add("hop", "walk", { phase: "started", kind: "call", call_id: "c-win", pointer_type: "git_land", selection_ref: sClosed.id })
    add("hop", "walk", { phase: "ended", kind: "call", call_id: "c-win", selection_ref: sClosed.id })
    add("gap", "detector", { gap_id: "wf-closed", status: "closed", category: "failing_test" })
    add("credits", "owner", { target: "gap", by_call: "git_land" })

    // A brand-new gap root under the same gap_id "wf-1" should inherit wf-1's episode loss (from "cell")
    const gReopen = add("gap", "detector", { gap_id: "wf-1", status: "open", category: "walk_failure" })
    // A brand-new detector gap with an unseen gap_id inherits from "asker"
    const gNewDet = add("gap", "detector", { gap_id: "wf-new", status: "open", category: "walk_failure" })
    // A gap asked by a different role ("person") with no asker-level data falls back to "kind"
    const gPerson = add("gap", "person", { gap_id: "p-gap", status: "open" })
    const head = rows.length

    const posts = F.foldFrom(
      rows,
      [
        `root:gap|asker:detector,id:${gReopen.id}`,
        `root:gap|asker:detector,id:${gNewDet.id}`,
        `root:gap|asker:person,id:${gPerson.id}`,
        "produce/request/gap|asker:detector",
      ],
      head,
      head,
    )
    expect(posts[0].from).toBe("cell")
    expect(posts[0].beta).toBeGreaterThan(posts[0].alpha)
    expect(posts[1].from).toBe("asker")
    expect(posts[1].alpha / (posts[1].alpha + posts[1].beta)).toBeLessThan(0.5)
    expect(posts[2].from).toBe("kind")
    // Normal move cell remains isolated from root: cells
    expect(posts[3].cell).toBe("produce/request/gap|asker:detector")
    expect(posts[3].from).toBe("cell")
    expect(posts[3].beta).toBe(5)
  })

  test("[MUST-FAIL] clean abstention: request { none } after change_wanted { wanted: false } is NOT debited as none|<sel>", () => {
    const { rows, add } = mkRows()
    const g1 = add("gap", "detector", { gap_id: "g-unwanted", status: "open", category: "walk_failure" })
    const sCw = add("selection", "walk", { arm: "treated", a: "produce/change_wanted/unscoped", cell: "produce/change_wanted/unscoped|asker:detector", root: g1.id, pool_refs: [g1.id] })
    add("change_wanted", "described", { wanted: false, repo: null, why: "no code fix needed", root: g1.id, input_refs: [g1.id], selection_ref: sCw.id })
    const sReq1 = add("selection", "walk", { arm: "treated", a: "produce/request/gap", cell: "produce/request/gap|asker:detector", root: g1.id, pool_refs: [g1.id] })
    add("request", "described", { none: "gap judged wanted: false", root: g1.id, selection_ref: sReq1.id })

    // Second gap WITH wanted: true must still debit premature `request { none }`
    const g2 = add("gap", "detector", { gap_id: "g-wanted", status: "open", category: "walk_failure" })
    const sCw2 = add("selection", "walk", { arm: "treated", a: "produce/change_wanted/unscoped", cell: "produce/change_wanted/unscoped|asker:detector", root: g2.id, pool_refs: [g2.id] })
    add("change_wanted", "described", { wanted: true, repo: "walk-vessel", what: "fix bug", root: g2.id, input_refs: [g2.id], selection_ref: sCw2.id })
    const sReq2 = add("selection", "walk", { arm: "treated", a: "produce/request/gap", cell: "produce/request/gap|asker:detector", root: g2.id, pool_refs: [g2.id] })
    add("request", "described", { none: "gave up anyway", root: g2.id, selection_ref: sReq2.id })

    // Reopened Episode 2 of g-unwanted (after Episode 1 closed) MUST NOT inherit Episode 1's wanted: false
    add("gap", "detector", { gap_id: "g-unwanted", status: "closed", category: "walk_failure" })
    const g1Reopened = add("gap", "detector", { gap_id: "g-unwanted", status: "open", category: "walk_failure" })
    const sReqReopened = add("selection", "walk", { arm: "treated", a: "produce/request/gap", cell: "produce/request/gap|asker:detector", root: g1Reopened.id, pool_refs: [g1Reopened.id] })
    add("request", "described", { none: "abandoned reopened episode", root: g1Reopened.id, selection_ref: sReqReopened.id })

    const mfs = F.fresh.moveFailures(rows, rows.length, rows.length)
    expect(mfs.some((m) => m.key === `none|${sReq1.id}`)).toBe(false)
    expect(mfs.some((m) => m.key === `none|${sReq2.id}`)).toBe(true)
    expect(mfs.some((m) => m.key === `none|${sReqReopened.id}`)).toBe(true)
  })

  test("[MUST-FAIL] isCleanEarnedTemplate quarantines malformed templates and store.episodes enforces fresh cap, dedup, and negative-lift retirement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-w10-store-"))
    const keys = ["RECORDS_VESSEL_ID", "RECORDS_PORT", "DISCOVERY_URL", "RECORDS_ENDPOINT", "RECORDS_DATA_DIR", "IDENTITY_VESSEL_URL", "METABOB_API_KEY"] as const
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    Object.assign(process.env, {
      RECORDS_VESSEL_ID: "records-test",
      RECORDS_PORT: "1",
      DISCOVERY_URL: "http://127.0.0.1:1",
      RECORDS_ENDPOINT: "http://127.0.0.1:1",
      RECORDS_DATA_DIR: dir,
      IDENTITY_VESSEL_URL: "http://127.0.0.1:1",
      METABOB_API_KEY: "test-key",
    })
    cleanups.push(() => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
      rmSync(dir, { recursive: true, force: true })
    })

    const S = await import(`../src/store?t=${Date.now()}`)
    expect(S.isCleanEarnedTemplate({
      shape: "activity_template", id: "t-bad-out", seq: 1, t: "", writer: "d", role: "described", input_refs: [],
      sig: { in: ["gap"], out: ["outcome"] }, calls: [{ shape: "gitDiff", pointer: {} }],
    })).toBe(false)
    expect(S.isCleanEarnedTemplate({
      shape: "activity_template", id: "t-bad-path", seq: 2, t: "", writer: "d", role: "described", input_refs: [],
      sig: { in: ["gap"], out: ["gitDiff"] }, calls: [{ shape: "git_diff", pointer: { cwd: "/var/lib/substrate/walk-trees/abc" } }],
    })).toBe(false)
    expect(S.isCleanEarnedTemplate({
      shape: "activity_template", id: "t-bad-tmp", seq: 2, t: "", writer: "d", role: "described", input_refs: [],
      sig: { in: ["gap"], out: ["gitDiff"] }, calls: [{ shape: "git_diff", pointer: { cwd: "prefix/tmp/scratch" } }],
    })).toBe(false)
    expect(S.isCleanEarnedTemplate({
      shape: "activity_template", id: "t-bad-tmpl", seq: 3, t: "", writer: "d", role: "described", input_refs: [],
      sig: { in: ["gap"], out: ["gitDiff"] }, calls: [{ shape: "git_diff", pointer: { cwd: "{{ bad.placeholder }}" } }],
    })).toBe(false)
    // Valid dot-indexed, hyphenated, and Go-template placeholders accepted by walk bind.ts & described-shape check.ts must pass
    expect(S.isCleanEarnedTemplate({
      shape: "activity_template", id: "t-good-placeholders", seq: 4, t: "", writer: "d", role: "described", input_refs: [],
      sig: { in: ["gap"], out: ["gitDiff"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in.0.cwd }}", tag: "{{ sig.in[0].foo-bar }}", fmt: "{{.State.Running}}" } }],
    })).toBe(true)

    // Populate a verified closed ask so earned() can admit clean templates
    const wAsk = S.write({ shape: "world_changed", summary: "ask 1" }, "person-1", "person").body as Row
    const selAns = S.write({ shape: "selection", arm: "treated", a: "call/git_diff", cell: "call/git_diff", root: wAsk.id, pool_refs: [wAsk.id] }, WALK, "walk").body as Row
    S.write({ shape: "hop", phase: "started", kind: "call", call_id: "h1", pointer_type: "git_diff", selection_ref: selAns.id }, WALK, "walk")
    S.write({ shape: "hop", phase: "ended", kind: "call", call_id: "h1", selection_ref: selAns.id }, WALK, "walk")
    const ans = S.write({ shape: "answer", text: "done", input_refs: [wAsk.id], selection_ref: selAns.id }, "desc-1", "described").body as Row
    S.write({ shape: "outcome", r: 1, input_refs: [ans.id] }, "person-1", "person")

    // Bad template replaying git_diff must be quarantined
    const badTpl = S.write({
      shape: "activity_template",
      sig: { in: ["world_changed"], out: ["outcome"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].repo }}" } }],
      selection_ref: selAns.id,
    }, "desc-1", "described").body as Row

    // 2 proven templates (wins >= 1 => alpha > 1) are NOT counted against MAX_FRESH_TEMPLATES = 8
    const provenTpls: Row[] = []
    for (let p = 0; p < 2; p++) {
      const pt = S.write({
        shape: "activity_template",
        sig: { in: [`provenIn_${p}`], out: [`provenOut_${p}`] },
        calls: [{ shape: "git_diff", pointer: { cwd: `proven_${p}` } }],
        selection_ref: selAns.id,
      }, "desc-1", "described").body as Row
      const pAsk = S.write({ shape: "world_changed", summary: `p-${p}` }, "person-1", "person").body as Row
      const sP = S.write({ shape: "selection", arm: "treated", a: `run/${pt.id}`, cell: `run/${pt.id}`, root: pAsk.id, pool_refs: [pAsk.id] }, WALK, "walk").body as Row
      const ansP = S.write({ shape: "answer", text: "ok", input_refs: [pAsk.id], selection_ref: sP.id }, "desc-1", "described").body as Row
      S.write({ shape: "outcome", r: 1, input_refs: [ansP.id] }, "person-1", "person")
      provenTpls.push(pt)
    }

    // 10 distinct clean fresh templates + 1 duplicate of the latest -> capped to 8 fresh
    const freshTpls: Row[] = []
    for (let i = 0; i < 10; i++) {
      freshTpls.push(S.write({
        shape: "activity_template",
        sig: { in: [`shapeA_${i}`], out: [`shapeB_${i}`] },
        calls: [{ shape: "git_diff", pointer: { cwd: `repo_${i}` } }],
        selection_ref: selAns.id,
      }, "desc-1", "described").body as Row)
    }
    const dupLatest = S.write({
      shape: "activity_template",
      sig: { in: ["shapeA_9"], out: ["shapeB_9"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "repo_9_dup" } }],
      selection_ref: selAns.id,
    }, "desc-1", "described").body as Row

    // Negative-lift earned template: 6 failed runs (n=6, wins=0 => alpha=1, beta=7 => ub90 < 0.40) -> retired
    const failingTpl = S.write({
      shape: "activity_template",
      sig: { in: ["shapeFail"], out: ["fileContent"] },
      calls: [{ shape: "git_diff", pointer: { cwd: "fail_repo" } }],
      selection_ref: selAns.id,
    }, "desc-1", "described").body as Row
    for (let f = 0; f < 6; f++) {
      const fAsk = S.write({ shape: "world_changed", summary: `f-${f}` }, "person-1", "person").body as Row
      const sRun = S.write({ shape: "selection", arm: "treated", a: `run/${failingTpl.id}`, cell: `run/${failingTpl.id}`, root: fAsk.id, pool_refs: [fAsk.id] }, WALK, "walk").body as Row
      const ansF = S.write({ shape: "answer", text: `fail-${f}`, input_refs: [fAsk.id], selection_ref: sRun.id }, "desc-1", "described").body as Row
      S.write({ shape: "outcome", r: 0, input_refs: [ansF.id] }, "person-1", "person")
    }

    const ep = S.episodes(WALK)
    const sharedTplIds = new Set(ep.shared.filter((r: Row) => r.shape === "activity_template").map((r: Row) => r.id))
    expect(sharedTplIds.has(badTpl.id)).toBe(false)
    expect(sharedTplIds.has(failingTpl.id)).toBe(false)
    for (const pt of provenTpls) expect(sharedTplIds.has(pt.id)).toBe(true)
    expect(sharedTplIds.has(dupLatest.id)).toBe(true)
    expect(sharedTplIds.has(freshTpls[9].id)).toBe(false) // deduplicated against dupLatest
    expect(sharedTplIds.has(freshTpls[0].id)).toBe(false) // evicted by MAX_FRESH_TEMPLATES = 8
    expect(sharedTplIds.size).toBe(10) // 2 proven (uncapped) + 8 fresh
  })

  test("[MUST-FAIL] graduationGapsOf sets walkable: true and topologyExpansionGapsOf gates on >=3 roots & fresh headroom", () => {
    const { rows, add } = mkRows()
    // Build a template with 8 wins so graduationGapsOf emits open walkable gap
    const tpl = add("activity_template", "described", { sig: { in: ["gap"], out: ["gitDiff"] }, calls: [{ shape: "git_diff", pointer: {} }, { shape: "code_search", pointer: {} }] })
    for (let i = 0; i < 8; i++) {
      const a = add("world_changed", "person", { summary: `win-${i}` })
      const sel = add("selection", "walk", { arm: "treated", a: `run/${tpl.id}`, cell: `run/${tpl.id}`, root: a.id, pool_refs: [a.id] })
      const ans = add("answer", "described", { input_refs: [a.id], selection_ref: sel.id })
      add("outcome", "person", { r: 1, input_refs: [ans.id] })
    }
    const grad = graduationGapsOf(rows)
    expect(grad.length).toBe(1)
    expect(String(grad[0].gap_id).startsWith(GRADUATE_PREFIX)).toBe(true)
    expect(grad[0].walkable).toBe(true)

    // Topology Signal 1: unserved non-constitutional shape across 2 roots (silent), then 3rd root (opens when fresh<8, suppressed when fresh>=8)
    for (let i = 1; i <= 2; i++) {
      const r = add("world_changed", "person", { summary: `u-${i}` })
      const s = add("selection", "walk", { arm: "treated", a: "produce/x", cell: "produce/x", root: r.id })
      add("failure", "walk", { unserved: "custom_digest", selection_ref: s.id, root: r.id })
    }
    expect(topologyExpansionGapsOf(rows, undefined, 0)).toEqual([])
    const r3 = add("world_changed", "person", { summary: "u-3" })
    const s3 = add("selection", "walk", { arm: "treated", a: "produce/x", cell: "produce/x", root: r3.id })
    add("failure", "walk", { unserved: "custom_digest", selection_ref: s3.id, root: r3.id })
    expect(topologyExpansionGapsOf(rows, undefined, 8)).toEqual([])
    const opened = topologyExpansionGapsOf(rows, undefined, 3)
    expect(opened.length).toBe(1)
    expect(opened[0].gap_id).toBe(`${TOPOLOGY_PREFIX}shape:custom_digest`)
    expect(opened[0].walkable).toBe(true)

    const gapOpenRow = add("gap", "detector", { ...opened[0] })
    expect(topologyExpansionGapsOf(rows, [gapOpenRow], 3)).toEqual([])
    add("shape_schema", "described", { target: "custom_digest", schema: { type: "object" }, inputs: ["world_changed"] })
    const closed = topologyExpansionGapsOf(rows, [gapOpenRow], 3)
    expect(closed.length).toBe(1)
    expect(closed[0].status).toBe("closed")
  })
})

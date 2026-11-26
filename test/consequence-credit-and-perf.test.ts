// SPDX-License-Identifier: MIT
// Step 2 invariants in records-vessel:
//   1. P0 O(1) consumedOf via Index.childTemplates + parityOf(rows) + sub-500ms foldFrom/selfCheck on 40k-row store.
//   2. P1 concept_VcYgxGWWysKn: test-verdict closures refused as "test_verdict" (no credit, no gather, no earned);
//      operational consequence closures credited + cross-root minter + earned; owner credits overrides respected (Law 1).
//   3. Hardening: constitutional protocol shapes refused 403 for DESCRIBED; prefilter before latest_by prevents
//      unverified DESCRIBED descriptors from shadowing owner/earned descriptors while stored:true stays raw.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as F from "../src/fold"
import { parityOf, selfCheck } from "../src/self-check"
import type { Row } from "../src/store"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const PERSON_KEY = "person-key-for-test"
const WALK = "walk-test"
const walk = { writer: WALK, role: "walk" }
const desc = { writer: "described-test", role: "described" }
const owner = { writer: "owner", role: "owner" }
const detector = { writer: "det-test", role: "detector" }

const plain = (gs: unknown[]) => JSON.stringify(gs, (_k, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v] : v))

let stop: () => void = () => {}
afterEach(() => stop())

const fresh = async () => {
  const discovery: Fake = fake((path) => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
  const identity: Fake = fake((_p, body) => body?.impulse?.pointer?.apiKey === PERSON_KEY
    ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-person", ownerKind: "person" } })
    : Response.json({ success: false }, { status: 401 }))
  const dir = mkdtempSync(join(tmpdir(), "records-step2-"))
  const port = freePort()
  const vessel = run("src/index.ts", {
    RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: String(port), DISCOVERY_URL: discovery.url,
    RECORDS_ENDPOINT: `http://127.0.0.1:${port}`, RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
  })
  stop = () => { vessel.kill(); discovery.stop(); identity.stop(); rmSync(dir, { recursive: true, force: true }) }
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
  const callRaw = async (key: string, pointer: object) => {
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify({ impulse: { pointer } }),
    })
    return { status: r.status, body: (await r.json()) as any }
  }
  const call = async (key: string, pointer: object) => (await callRaw(key, pointer)).body
  const writeRaw = (key: string, row: object, as?: { writer: string; role: string }) => callRaw(key, { type: "record_write", row, ...(as ?? {}) })
  const write = (key: string, row: object, as?: { writer: string; role: string }) => call(key, { type: "record_write", row, ...(as ?? {}) })
  const episodes = async () => (await call(NODE_KEY, { type: "record_read", episode: WALK, roots: "all" })) as
    { shared: Array<{ id: string; shape: string; target?: string }>; roots: Array<{ root: { id: string }; rows: Array<{ id: string }> }> }
  const arm = () => write(NODE_KEY, { shape: "arm", vessel_id: WALK, arm: "treated" }, owner)
  const ask = (what: string) => write(PERSON_KEY, { shape: "world_changed", what })
  const select = (root: string, extra: Record<string, unknown> = {}) =>
    write(NODE_KEY, { shape: "selection", arm: "treated", root, cell: "c", pool_refs: [root], input_refs: [root], ...extra }, walk)
  return { callRaw, call, writeRaw, write, episodes, arm, ask, select }
}

describe("P0 — O(1) consumedOf via Index.childTemplates & 40k-row perf/parity", () => {
  test("[MUST-FAIL] 40k bulk rows BEFORE 1500 graded outcomes + 800 walk failures with nested template_ref: parityOf exact & foldFrom/selfCheck < 500ms", () => {
    const T0 = Date.parse("2099-01-01T10:00:00Z")
    let seq = 0
    const rows: Row[] = []
    const add = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row => {
      const r = { shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields } as Row
      rows.push(r)
      return r
    }

    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 8 })
    add("shape_schema", "owner", { target: "answer", inputs: ["world_changed"] })

    // Mint child and parent templates once
    const askSeed = add("world_changed", "person", { what: "seed" })
    const childMint = add("selection", "walk", { arm: "treated", root: askSeed.id, a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|seed" })
    const childTpl = add("activity_template", "described", { selection_ref: childMint.id, calls: [{ shape: "fs_edit", pointer: {} }] })
    const parentMint = add("selection", "walk", { arm: "treated", root: askSeed.id, a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|parent" })
    const parentTpl = add("activity_template", "described", { selection_ref: parentMint.id, calls: [{ shape: "activity_template", pointer: { id: childTpl.id } }] })

    // Place 40,000 bulk rows (20,000 hops + 20,000 filler rows) BEFORE graded outcomes and walk failures so
    // byId.size >= 40,000 during BOTH foldFrom() and selfCheck()'s owe()->reached() calls (Mutant A would scan
    // ~92M+ Map entries and blow past 500ms).
    for (let i = 0; i < 20_000; i++) {
      add("hop", "walk", { phase: i % 2 === 0 ? "started" : "ended", kind: "call", call_id: `bulk-${i}`, selection_ref: "sel-bulk", pointer_type: "fs_read" })
    }
    for (let i = 0; i < 20_000; i++) {
      add("note", "walk", { text: `pad-${i}` })
    }

    // 1,500 graded outcomes invoking reached() across parent + nested child template_ref hops
    const queriedCells: string[] = ["produce/activity_template/ch1|seed", "produce/activity_template/ch1|parent"]
    for (let i = 0; i < 1_500; i++) {
      const ask = add("world_changed", "person", { what: `ask-${i}` }, i * 10)
      const rSel = add("selection", "walk", { arm: "treated", root: ask.id, a: `run/${parentTpl.id}`, cell: `run/${parentTpl.id}|ask` }, i * 10 + 1)
      const hChild = add("hop", "walk", { phase: "ended", kind: "run", call_id: `cc-${i}`, template_ref: childTpl.id, selection_ref: rSel.id }, i * 10 + 2)
      const aSel = add("selection", "walk", { arm: "treated", root: ask.id, a: "produce/answer/ch1", cell: `produce/answer/ch1|ask-${i % 10}` }, i * 10 + 3)
      const ans = add("answer", "described", { selection_ref: aSel.id, input_refs: [ask.id, hChild.id], uses: [hChild.id], text: "ok" }, i * 10 + 4)
      add("outcome", "person", { r: 1, input_refs: [ask.id, ans.id] }, i * 10 + 5)
      if (i < 10) queriedCells.push(`produce/answer/ch1|ask-${i}`)
    }

    // 800 walk failures replayed through selfCheck() (each triggering owe() -> reached() when byId.size > 49k)
    for (let i = 0; i < 800; i++) {
      const ask = add("world_changed", "person", { what: `fail-${i}` })
      const fSel = add("selection", "walk", {
        arm: "treated", root: ask.id, a: `run/${parentTpl.id}`, cell: `run/${parentTpl.id}|fail`,
        posts_seq: seq, cands: [{ id: `run/${parentTpl.id}`, root: ask.id, ctx: "fail" }], posts: [{ alpha: 1, beta: 1, from: "cell" }],
      })
      add("hop", "walk", { phase: "ended", kind: "run", call_id: `cf-${i}`, template_ref: childTpl.id, selection_ref: fSel.id })
      add("failure", "walk", { selection_ref: fSel.id, call_id: `cf-${i}`, status: 400, blames: "request", body: "bad" })
    }
    expect(rows.length).toBeGreaterThan(50_000)

    const { kept, built } = parityOf(rows)
    expect(kept.childTemplates.size).toBe(2_300)
    expect(kept).toEqual(built)

    const head = rows[rows.length - 1]!.seq
    const tFold0 = performance.now()
    const posts = F.foldFrom(rows, queriedCells, head, head)
    const foldMs = performance.now() - tFold0
    expect(posts[0]!.alpha).toBeGreaterThan(1) // childMint received cross-root credit through childTemplates
    expect(foldMs).toBeLessThan(500)

    const tSelf0 = performance.now()
    const findings = selfCheck(rows)
    const selfMs = performance.now() - tSelf0
    expect(Array.isArray(findings)).toBe(true)
    expect(selfMs).toBeLessThan(500)
    console.log(`[perf-40k] rows=${rows.length} foldFrom=${foldMs.toFixed(1)}ms selfCheck=${selfMs.toFixed(1)}ms`)
  })
})

describe("P1 — concept_VcYgxGWWysKn: no credit from test verdicts, operational consequences credit", () => {
  const buildGapWorld = (opts: {
    creditsExtra?: Record<string, unknown>
    openFields?: Record<string, unknown>
    closeFields?: Record<string, unknown>
  }) => {
    const T0 = Date.parse("2099-01-01T10:00:00Z")
    let seq = 0
    const rows: Row[] = []
    const add = (shape: string, role: string, fields: Record<string, unknown>): Row => {
      const r = { shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + seq * 1000).toISOString(), input_refs: [], ...fields } as Row
      rows.push(r)
      return r
    }
    add("credits", "owner", { target: "gap", by_call: "git_land", ...(opts.creditsExtra ?? {}) })
    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 8 })
    // Cross-root template minted on another gap
    const gMint = add("gap", "detector", { gap_id: "g-mint", status: "open" })
    const mintSel = add("selection", "walk", { arm: "treated", root: gMint.id, a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|mint", pool_refs: [gMint.id] })
    const tpl = add("activity_template", "described", { selection_ref: mintSel.id, calls: [{ shape: "git_land", pointer: {} }] })

    // Target gap worked by run/tpl + git_land, then closed
    const gOpen = add("gap", "detector", { gap_id: "g-target", status: "open", ...(opts.openFields ?? {}) })
    const runSel = add("selection", "walk", { arm: "treated", root: gOpen.id, a: `run/${tpl.id}`, cell: `run/${tpl.id}|gap`, pool_refs: [gOpen.id] })
    add("hop", "walk", { phase: "started", kind: "run", call_id: "cl1", pointer_type: "git_land", selection_ref: runSel.id })
    add("hop", "walk", { phase: "ended", kind: "run", call_id: "cl1", selection_ref: runSel.id })
    const gClose = add("gap", "detector", { gap_id: "g-target", status: "closed", ...(opts.closeFields ?? {}) })
    return { rows, head: gClose.seq, runCell: `run/${tpl.id}|gap`, mintCell: "produce/activity_template/ch1|mint" }
  }

  test("[MUST-FAIL] named_tests_pass, named_tests_absent, and category failing_test closes are refused as test_verdict with zero credit and zero gather", () => {
    const cases = [
      { name: "named_tests_pass", closeFields: { closed_reason: "named_tests_pass" } },
      { name: "named_tests_absent", closeFields: { closed_reason: "named_tests_absent" } },
      { name: "category failing_test on open", openFields: { category: "failing_test" } },
      { name: "category failing_test on close", closeFields: { category: "failing_test" } },
    ]
    for (const tc of cases) {
      const w = buildGapWorld({ openFields: tc.openFields, closeFields: tc.closeFields })
      const gatheredBefore = F.gapChainsGathered()
      const lazy = F.gapClosures(w.rows, w.head, w.head)
      const gatheredAfter = F.gapChainsGathered()
      const scan = F.gapClosuresScan(w.rows, w.head, w.head)
      expect(plain(lazy)).toEqual(plain(scan))
      expect(gatheredAfter - gatheredBefore).toBe(0)
      expect(lazy.length).toBe(1)
      expect(lazy[0]!.ok).toBe(false)
      expect(lazy[0]!.refused).toBe("test_verdict")
      expect(lazy[0]!.cells.size).toBe(0)
      const [pRun, pMint] = F.foldFrom(w.rows, [w.runCell, w.mintCell], w.head, w.head)
      expect(pRun!.alpha).toBe(1)
      expect(pMint!.alpha).toBe(1)
    }
  })

  test("[MUST-FAIL] operational consequence close credits chain + cross-root minter; owner credits row overrides test_reasons/test_categories (Law 1)", () => {
    const op = buildGapWorld({
      openFields: { category: "walk_failure" },
      closeFields: { category: "walk_failure", closed_reason: "no failure of this class for 2000 rows, and its tool was called since without it" },
    })
    const lazy = F.gapClosures(op.rows, op.head, op.head)
    const scan = F.gapClosuresScan(op.rows, op.head, op.head)
    expect(plain(lazy)).toEqual(plain(scan))
    expect(lazy[0]!.ok).toBe(true)
    expect(lazy[0]!.r).toBe(1)
    const [pRun, pMint] = F.foldFrom(op.rows, [op.runCell, op.mintCell], op.head, op.head)
    expect(pRun!.alpha).toBe(2)
    expect(pMint!.alpha).toBeCloseTo(1.7)

    // Law 1 override: owner explicitly sets custom test_reasons / test_categories
    const overrideAllow = buildGapWorld({
      creditsExtra: { test_reasons: ["custom_test_reason"], test_categories: ["custom_test_cat"] },
      openFields: { category: "failing_test" },
      closeFields: { closed_reason: "named_tests_pass" },
    })
    expect(F.gapClosures(overrideAllow.rows, overrideAllow.head, overrideAllow.head)[0]!.ok).toBe(true)

    const overrideBlock = buildGapWorld({
      creditsExtra: { test_reasons: ["custom_test_reason"], test_categories: ["custom_test_cat"] },
      closeFields: { closed_reason: "custom_test_reason" },
    })
    const blocked = F.gapClosures(overrideBlock.rows, overrideBlock.head, overrideBlock.head)[0]!
    expect(blocked.ok).toBe(false)
    expect(blocked.refused).toBe("test_verdict")
  })

  test("[MUST-FAIL] end-to-end store: test_verdict close does NOT earn templates, whereas operational consequence close DOES earn templates", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, { shape: "credits", target: "gap", by_call: "git_land" }, owner)

    // 1. Test-verdict close: named_tests_pass -> refused test_verdict -> template NOT earned
    const gTest = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-test", status: "open", category: "failing_test" }, detector)
    const sLandT = await r.select(gTest.id, { a: "call/git_land", cell: "call/git_land|gap" })
    await r.write(NODE_KEY, { shape: "hop", call_id: "ct1", phase: "started", kind: "call", pointer_type: "git_land", selection_ref: sLandT.id, input_refs: [sLandT.id] }, walk)
    await r.write(NODE_KEY, { shape: "hop", call_id: "ct1", phase: "ended", kind: "call", selection_ref: sLandT.id, input_refs: [sLandT.id] }, walk)
    const sTplT = await r.select(gTest.id, { a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|gap" })
    const tplTest = await r.write(NODE_KEY, { shape: "activity_template", sig: { in: ["gap"], out: ["gitLandResult"] }, calls: [{ shape: "git_land", pointer: {} }], selection_ref: sTplT.id, input_refs: [gTest.id] }, desc)
    await r.write(NODE_KEY, { shape: "gap", gap_id: "g-test", status: "closed", closed_reason: "named_tests_pass" }, detector)
    expect((await r.episodes()).shared.map((x) => x.id)).not.toContain(tplTest.id)

    // 2. Operational consequence close: walk_failure -> credited -> template IS earned
    const gOp = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-op", status: "open", category: "walk_failure" }, detector)
    const sLandO = await r.select(gOp.id, { a: "call/git_land", cell: "call/git_land|gap" })
    await r.write(NODE_KEY, { shape: "hop", call_id: "co1", phase: "started", kind: "call", pointer_type: "git_land", selection_ref: sLandO.id, input_refs: [sLandO.id] }, walk)
    await r.write(NODE_KEY, { shape: "hop", call_id: "co1", phase: "ended", kind: "call", selection_ref: sLandO.id, input_refs: [sLandO.id] }, walk)
    const sTplO = await r.select(gOp.id, { a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|gap" })
    const tplOp = await r.write(NODE_KEY, { shape: "activity_template", sig: { in: ["gap"], out: ["gitLandResult"] }, calls: [{ shape: "git_land", pointer: {} }], selection_ref: sTplO.id, input_refs: [gOp.id] }, desc)
    await r.write(NODE_KEY, { shape: "gap", gap_id: "g-op", status: "closed", category: "walk_failure", closed_reason: "no failure of this class for 2000 rows, and its tool was called since without it" }, detector)
    expect((await r.episodes()).shared.map((x) => x.id)).toContain(tplOp.id)
  })
})

describe("Hardening — expanded CONSTITUTIONAL_TARGETS & latest_by prefilter", () => {
  test("[MUST-FAIL] DESCRIBED shape_schema writes for protocol shapes return 403, and unverified descriptors never shadow owner/earned rows under latest_by", async () => {
    const r = await fresh()
    await r.arm()
    const a = await r.ask("test hardening")
    const sel = await r.select(a.id, { a: "produce/shape_schema/ch1", cell: "produce/shape_schema/ch1|ask" })

    // Protocol shapes must be refused 403 for DESCRIBED
    for (const target of ["posterior", "selection", "gitDiff", "hop", "failure", "record_write", "request_acts", "owner_seeded"]) {
      const res = await r.writeRaw(NODE_KEY, { shape: "shape_schema", target, inputs: ["world_changed"], selection_ref: sel.id }, desc)
      expect(res.status).toBe(403)
    }

    // Owner writes foo_plan schema first; later an unverified DESCRIBED writes foo_plan on open ask
    const ownerSch = await r.write(NODE_KEY, { shape: "shape_schema", target: "foo_plan", inputs: ["world_changed"], version: 1 }, owner)
    const unverifiedRes = await r.writeRaw(NODE_KEY, { shape: "shape_schema", target: "foo_plan", inputs: ["world_changed"], version: 2, selection_ref: sel.id, input_refs: [a.id] }, desc)
    expect(unverifiedRes.status).toBe(200)

    // latest_by: "target" MUST return the owner/verified row (version 1), NOT drop foo_plan due to shadowing
    const latestVisible = (await r.call(NODE_KEY, { type: "record_read", shape: "shape_schema", latest_by: "target" })) as Array<{ id: string; target?: string }>
    expect(latestVisible.find((x) => x.target === "foo_plan")?.id).toBe(ownerSch.id)

    // stored: true MUST still return the raw latest stored row (unverified version 2)
    const latestStored = (await r.call(NODE_KEY, { type: "record_read", shape: "shape_schema", latest_by: "target", stored: true })) as Array<{ id: string; target?: string }>
    expect(latestStored.find((x) => x.target === "foo_plan")?.id).toBe(unverifiedRes.body.id)

    // Unrelated shape reads (e.g. shape: "gap") skip the descriptor prefilter and still read cleanly
    const g = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-unrelated", status: "open" }, detector)
    const gaps = (await r.call(NODE_KEY, { type: "record_read", shape: "gap" })) as Array<{ id: string }>
    expect(gaps.map((x) => x.id)).toContain(g.id)
  })
})

// SPDX-License-Identifier: MIT
// Wave 1 compounding invariants in records-vessel:
//   1. Cross-root run/* minter & nested child template_ref credit on detector gap closures, reached(), and moveFailures.
//   2. Autonomous earned() on credited detector gap closures + bounded 1-selection post-close extraction window.
//   3. Open-topology shape_schema / shape_description split (constitutional 403 vs verified-closed visibility gate).
//   4. Forward-arm context|<target>|<context_shape> posteriors isolated from normal move/cell/kind posteriors.
//   5. Certainty-driven resolver graduation detector (graduate-template:<id> open at >=8 runs & >=0.85, close <0.85).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as F from "../src/fold"
import { GRADUATE_PREFIX, graduationGapsOf } from "../src/self-check"
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
  const dir = mkdtempSync(join(tmpdir(), "records-wave1-"))
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
    { shared: Array<{ id: string; shape: string; target?: string; of?: string }>; roots: Array<{ root: { id: string; status?: string }; rows: Array<{ id: string }> }> }
  const arm = () => write(NODE_KEY, { shape: "arm", vessel_id: WALK, arm: "treated" }, owner)
  const ask = (what: string) => write(PERSON_KEY, { shape: "world_changed", what })
  const select = (root: string, extra: Record<string, unknown> = {}) =>
    write(NODE_KEY, { shape: "selection", arm: "treated", root, cell: "c", pool_refs: [root], input_refs: [root], ...extra }, walk)
  return { callRaw, call, writeRaw, write, episodes, arm, ask, select }
}

describe("Wave 1 — cross-root template & nested-child credit in fold.ts", () => {
  const T0 = Date.parse("2099-01-01T10:00:00Z")
  const mk = () => {
    let seq = 0
    const rows: Row[] = []
    const add = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row => {
      const r = { shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields } as Row
      rows.push(r)
      return r
    }
    return { rows, add }
  }

  test("[MUST-FAIL] gapClosures credits cross-root run/* minter at gamma and nested child template_ref at gamma / gamma^2, matching gapClosuresScan", () => {
    const { rows, add } = mk()
    add("credits", "owner", { target: "gap", by_call: "git_land" })
    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 })

    // Root A mints child template; Root B mints parent template
    const gA = add("gap", "detector", { gap_id: "gA", status: "open" })
    const childMintSel = add("selection", "walk", { arm: "treated", root: gA.id, a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|mintA", pool_refs: [gA.id] })
    const childTpl = add("activity_template", "described", { selection_ref: childMintSel.id, calls: [{ shape: "fs_edit", pointer: {} }] })

    const gB = add("gap", "detector", { gap_id: "gB", status: "open" })
    const parentMintSel = add("selection", "walk", { arm: "treated", root: gB.id, a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|mintB", pool_refs: [gB.id] })
    const parentTpl = add("activity_template", "described", { selection_ref: parentMintSel.id, calls: [{ shape: "activity_template", pointer: { id: childTpl.id } }, { shape: "git_land", pointer: {} }] })

    // Root C runs parentTpl (which runs childTpl via nested hop template_ref) and lands git_land, closing gC
    const gC = add("gap", "detector", { gap_id: "gC", status: "open" })
    const ctx = "|gap,asker:detector,age:0"
    const runSel = add("selection", "walk", { arm: "treated", root: gC.id, a: `run/${parentTpl.id}`, cell: `run/${parentTpl.id}${ctx}`, pool_refs: [gC.id] })
    add("hop", "walk", { phase: "started", kind: "run", call_id: "c-child", pointer_type: "activity_template", template_ref: childTpl.id, selection_ref: runSel.id })
    add("hop", "walk", { phase: "ended", kind: "run", call_id: "c-child", template_ref: childTpl.id, selection_ref: runSel.id })
    add("hop", "walk", { phase: "started", kind: "run", call_id: "c-land", pointer_type: "git_land", selection_ref: runSel.id })
    add("hop", "walk", { phase: "ended", kind: "run", call_id: "c-land", selection_ref: runSel.id })
    add("gap", "detector", { gap_id: "gC", status: "closed" })

    const head = rows[rows.length - 1]!.seq
    const lazy = F.gapClosures(rows, head, head)
    const scan = F.gapClosuresScan(rows, head, head)
    expect(plain(lazy)).toEqual(plain(scan))
    expect(lazy.length).toBe(1)
    expect(lazy[0]!.ok).toBe(true)
    const w = lazy[0]!.weights
    expect(w.get(`run/${parentTpl.id}${ctx}`)).toBe(1)
    expect(w.get("produce/activity_template/ch1|mintB")).toBeCloseTo(0.7)
    expect(w.get(`run/${childTpl.id}${ctx}`)).toBeCloseTo(0.7)
    expect(w.get("produce/activity_template/ch1|mintA")).toBeCloseTo(0.49)
  })

  test("[MUST-FAIL] nested child template_ref is traversed by reached() and debited in moveFailures on run failure", () => {
    const { rows, add } = mk()
    const T: F.Travel = { w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 }
    add("credits", "owner", { target: "selection", ...T })
    const askA = add("world_changed", "person", { what: "a" })
    const childMintSel = add("selection", "walk", { arm: "treated", root: askA.id, a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|childMint" })
    const childTpl = add("activity_template", "described", { selection_ref: childMintSel.id, calls: [{ shape: "fs_edit", pointer: {} }] })
    const parentMintSel = add("selection", "walk", { arm: "treated", root: askA.id, a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|parentMint" })
    const parentTpl = add("activity_template", "described", { selection_ref: parentMintSel.id, calls: [{ shape: "activity_template", pointer: { id: childTpl.id } }] })

    const askB = add("world_changed", "person", { what: "b" })
    const okRunSel = add("selection", "walk", { arm: "treated", root: askB.id, a: `run/${parentTpl.id}`, cell: `run/${parentTpl.id}|b` })
    add("hop", "walk", { phase: "ended", kind: "run", call_id: "c-ok", template_ref: childTpl.id, selection_ref: okRunSel.id })
    const reachedMap = F.reached(F.indexOf(rows), okRunSel.id, T, { by: "person", r: 1 })
    expect(reachedMap.get(parentMintSel.id)).toBeCloseTo(0.7)
    expect(reachedMap.get(childMintSel.id)).toBeCloseTo(0.7)

    // Failing run selection debits both parent mint and nested child mint
    const badRunSel = add("selection", "walk", { arm: "treated", root: askB.id, a: `run/${parentTpl.id}`, cell: `run/${parentTpl.id}|bad` })
    add("hop", "walk", { phase: "started", kind: "run", call_id: "c-bad", template_ref: childTpl.id, selection_ref: badRunSel.id })
    add("failure", "walk", { selection_ref: badRunSel.id, call_id: "c-bad", status: 400, blames: "request", body: "bad edit" })

    const head = rows[rows.length - 1]!.seq
    const fails = F.moveFailures(rows, head, head)
    const keys = fails.map((g) => g.key)
    expect(keys).toContain(`mint|${badRunSel.id}`)
    expect(keys).toContain(`mint-child|${badRunSel.id}|${childTpl.id}`)
    const childDebit = fails.find((g) => g.key === `mint-child|${badRunSel.id}|${childTpl.id}`)!
    expect(childDebit.r).toBe(0)
    expect(childDebit.weights.get("produce/activity_template/ch1|childMint")).toBe(1)
  })
})

describe("Wave 1 — forward-arm context|<target>|<context_shape> posteriors", () => {
  test("[MUST-FAIL] context| posteriors fold from uses + terminal root outcomes without affecting normal move posteriors", () => {
    let seq = 0
    const rows: Row[] = []
    const T0 = Date.parse("2099-01-01T10:00:00Z")
    const add = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row => {
      const r = { shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields } as Row
      rows.push(r)
      return r
    }
    add("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 })
    add("credits", "owner", { target: "gap", by_call: "git_land" })

    // Root 1: person r=1; request used fileContent + gitDiff
    const ask1 = add("world_changed", "person", { what: "fix 1" })
    const fc1 = add("fileContent", "walk", { path: "a.ts", content: "x" })
    const diff1 = add("gitDiff", "walk", { diff: "+x" })
    const sReq1 = add("selection", "walk", { arm: "treated", root: ask1.id, a: "produce/request/ch1", cell: "produce/request/ch1|ask" })
    add("request", "described", { selection_ref: sReq1.id, input_refs: [ask1.id, fc1.id, diff1.id], uses: [fc1.id, diff1.id], pointer: { type: "fs_edit" } })
    const sAns1 = add("selection", "walk", { arm: "treated", root: ask1.id, a: "produce/answer/ch1", cell: "produce/answer/ch1|ask" })
    const ans1 = add("answer", "described", { selection_ref: sAns1.id, input_refs: [ask1.id], text: "fixed" })
    add("outcome", "person", { r: 1, input_refs: [ask1.id, ans1.id] }, 1000)

    // Root 2: person r=0; request used fileContent only
    const ask2 = add("world_changed", "person", { what: "fix 2" })
    const fc2 = add("fileContent", "walk", { path: "b.ts", content: "y" })
    const sReq2 = add("selection", "walk", { arm: "treated", root: ask2.id, a: "produce/request/ch1", cell: "produce/request/ch1|ask" })
    add("request", "described", { selection_ref: sReq2.id, input_refs: [ask2.id, fc2.id], uses: [fc2.id], pointer: { type: "fs_edit" } })
    const sAns2 = add("selection", "walk", { arm: "treated", root: ask2.id, a: "produce/answer/ch1", cell: "produce/answer/ch1|ask" })
    const ans2 = add("answer", "described", { selection_ref: sAns2.id, input_refs: [ask2.id], text: "nope" })
    add("outcome", "person", { r: 0, input_refs: [ask2.id, ans2.id] }, 2000)

    // Root 3: credited gap close (r=1); request used gitDiff
    const g3 = add("gap", "detector", { gap_id: "g3", status: "open" })
    const diff3 = add("gitDiff", "walk", { diff: "+z" })
    const sReq3 = add("selection", "walk", { arm: "treated", root: g3.id, a: "produce/request/ch1", cell: "produce/request/ch1|gap", pool_refs: [g3.id] })
    add("request", "described", { selection_ref: sReq3.id, input_refs: [g3.id, diff3.id], uses: [diff3.id], pointer: { type: "git_land" } })
    const sLand3 = add("selection", "walk", { arm: "treated", root: g3.id, a: "call/git_land", cell: "call/git_land|gap", pool_refs: [g3.id] })
    add("hop", "walk", { phase: "started", kind: "call", call_id: "cl3", pointer_type: "git_land", selection_ref: sLand3.id })
    add("hop", "walk", { phase: "ended", kind: "call", call_id: "cl3", selection_ref: sLand3.id })
    add("gap", "detector", { gap_id: "g3", status: "closed" })

    const head = rows[rows.length - 1]!.seq
    const normalOnly = F.foldFrom(rows, ["produce/answer/ch1|ask", "call/git_land|gap"], head, head)
    const mixed = F.foldFrom(rows, ["produce/answer/ch1|ask", "call/git_land|gap", "context|request|fileContent", "context|request|gitDiff", "context|request|unusedShape"], head, head)

    // Normal cells are byte-for-byte identical whether context| cells were requested or not
    expect(mixed.slice(0, 2)).toEqual(normalOnly)
    // Counterfactual EB lift (m = 2): pBase = (2+1)/(3+2) = 0.6.
    // gitDiff (2/2 vs complement 0/1 -> pCf = 0.4, pUse = 0.7 -> score = 0.65) > unusedShape (0.5) > fileContent (1/2 vs complement 1/1 -> score = 53/120).
    expect(mixed[2]!.from).toBe("cell")
    expect(mixed[2]!.alpha).toBeCloseTo(53 / 30, 9)
    expect(mixed[2]!.beta).toBeCloseTo(67 / 30, 9)
    expect(mixed[3]!.from).toBe("cell")
    expect(mixed[3]!.alpha).toBeCloseTo(2.6, 9)
    expect(mixed[3]!.beta).toBeCloseTo(1.4, 9)
    expect(mixed[4]).toEqual({ cell: "context|request|unusedShape", alpha: 1, beta: 1, from: "none" })
  })
})

describe("Wave 1 — autonomous earned(), 1-selection post-close window, and open-topology schemas", () => {
  test("[MUST-FAIL] credited detector gap close keeps a 1-selection post-close extraction window, earns trace-faithful templates, and excludes hallucinated calls", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, { shape: "credits", target: "gap", by_call: "git_land" }, owner)

    // Ordinary unlanded gap closes immediately with NO post-close window
    await r.write(NODE_KEY, { shape: "gap", gap_id: "g-plain", status: "open" }, detector)
    await r.write(NODE_KEY, { shape: "gap", gap_id: "g-plain", status: "closed" }, detector)
    const afterPlain = await r.episodes()
    expect(afterPlain.roots.every((x) => x.root.status !== "closed")).toBe(true)

    // Landed gap: open -> fs_edit + git_land -> closed
    const gOpen = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-land", status: "open" }, detector)
    const sEdit = await r.select(gOpen.id, { a: "call/fs_edit", cell: "call/fs_edit|gap" })
    await r.write(NODE_KEY, { shape: "hop", call_id: "ce1", phase: "started", kind: "call", pointer_type: "fs_edit", selection_ref: sEdit.id, input_refs: [sEdit.id] }, walk)
    await r.write(NODE_KEY, { shape: "hop", call_id: "ce1", phase: "ended", kind: "call", selection_ref: sEdit.id, input_refs: [sEdit.id] }, walk)
    const sLand = await r.select(gOpen.id, { a: "call/git_land", cell: "call/git_land|gap" })
    await r.write(NODE_KEY, { shape: "hop", call_id: "cl1", phase: "started", kind: "call", pointer_type: "git_land", selection_ref: sLand.id, input_refs: [sLand.id] }, walk)
    await r.write(NODE_KEY, { shape: "hop", call_id: "cl1", phase: "ended", kind: "call", selection_ref: sLand.id, input_refs: [sLand.id] }, walk)
    const gClose = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-land", status: "closed" }, detector)

    // Immediately after credited close: gClose stays in episodes().roots for 1 extraction selection, with full episode rows
    const win1 = await r.episodes()
    const closedRoot = win1.roots.find((x) => x.root.id === gClose.id)
    expect(closedRoot).toBeDefined()
    expect(closedRoot!.rows.map((x) => x.id)).toContain(gOpen.id)
    expect(closedRoot!.rows.map((x) => x.id)).toContain(sEdit.id)
    expect(closedRoot!.rows.map((x) => x.id)).toContain(gClose.id)

    // Run the 1 post-close extraction selection citing gClose.id: mint 1 trace-faithful template + 1 hallucinated template
    const sExtract = await r.select(gClose.id, { a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|gap" })
    const goodTpl = await r.write(NODE_KEY, {
      shape: "activity_template",
      sig: { in: ["gap"], out: ["gitLandResult"] },
      calls: [{ shape: "fs_edit", pointer: {} }, { shape: "git_land", pointer: {} }],
      selection_ref: sExtract.id,
      input_refs: [gClose.id],
    }, desc)
    const fakeTpl = await r.write(NODE_KEY, {
      shape: "activity_template",
      sig: { in: ["gap"], out: ["gitLandResult"] },
      calls: [{ shape: "never_called_tool", pointer: {} }],
      selection_ref: sExtract.id,
      input_refs: [gClose.id],
    }, desc)

    // Immediately after that 1 selection: gClose exits open roots, goodTpl is in shared(w), fakeTpl is excluded
    const afterExtract = await r.episodes()
    expect(afterExtract.roots.find((x) => x.root.id === gClose.id)).toBeUndefined()
    const sharedIds = afterExtract.shared.map((x) => x.id)
    expect(sharedIds).toContain(goodTpl.id)
    expect(sharedIds).not.toContain(fakeTpl.id)
  })

  test("[MUST-FAIL] open-topology shape_schema split refuses constitutional writes (403) and gates novel schemas until verified close", async () => {
    const r = await fresh()
    await r.arm()
    const a = await r.ask("invent an intermediate plan shape")
    const sel = await r.select(a.id, { a: "produce/shape_schema/ch1", cell: "produce/shape_schema/ch1|ask" })

    // Constitutional targets & non-DESCRIBED roles are refused with 403
    for (const target of ["request", "outcome", "channel", "answer", "activity_template", "gap"]) {
      const res = await r.writeRaw(NODE_KEY, { shape: "shape_schema", target, inputs: ["world_changed"], selection_ref: sel.id }, desc)
      expect(res.status).toBe(403)
    }
    // Forging ask: true on a novel target is also refused with 403
    expect((await r.writeRaw(NODE_KEY, { shape: "shape_schema", target: "intermediate_plan", ask: true, inputs: ["world_changed"], selection_ref: sel.id }, desc)).status).toBe(403)
    expect((await r.writeRaw(NODE_KEY, { shape: "shape_schema", target: "intermediate_plan", inputs: [{ shape: "world_changed", ask: true }], selection_ref: sel.id }, desc)).status).toBe(403)
    // Walk and person roles still get 403 even on novel targets
    expect((await r.writeRaw(NODE_KEY, { shape: "shape_schema", target: "intermediate_plan", inputs: ["world_changed"] }, walk)).status).toBe(403)
    expect((await r.writeRaw(PERSON_KEY, { shape: "shape_schema", target: "intermediate_plan", inputs: ["world_changed"] })).status).toBe(403)

    // Novel open-topology shape_schema + shape_description written by DESCRIBED succeed with 200
    const schRes = await r.writeRaw(NODE_KEY, {
      shape: "shape_schema", target: "intermediate_plan", inputs: ["world_changed"], selection_ref: sel.id, input_refs: [a.id],
    }, desc)
    expect(schRes.status).toBe(200)
    const descRes = await r.writeRaw(NODE_KEY, {
      shape: "shape_description", of: "intermediate_plan", description: "Intermediate plan", selection_ref: sel.id, input_refs: [a.id],
    }, desc)
    expect(descRes.status).toBe(200)

    // While ask is still open (unverified): hidden from record_read & shared(w), visible only with stored: true
    const schemasBefore = (await r.call(NODE_KEY, { type: "record_read", shape: "shape_schema" })) as Array<{ id: string }>
    expect(schemasBefore.map((x) => x.id)).not.toContain(schRes.body.id)
    const descsBefore = (await r.call(NODE_KEY, { type: "record_read", shape: "shape_description" })) as Array<{ id: string }>
    expect(descsBefore.map((x) => x.id)).not.toContain(descRes.body.id)
    expect((await r.episodes()).shared.map((x) => x.id)).not.toContain(schRes.body.id)
    const storedSchemas = (await r.call(NODE_KEY, { type: "record_read", shape: "shape_schema", stored: true })) as Array<{ id: string }>
    expect(storedSchemas.map((x) => x.id)).toContain(schRes.body.id)

    // Close ask with person r=1: now visible in BOTH record_read AND shared(w)
    const ansSel = await r.select(a.id, { a: "produce/answer/ch1", cell: "produce/answer/ch1|ask" })
    const ans = await r.write(NODE_KEY, { shape: "answer", text: "done", selection_ref: ansSel.id, input_refs: [a.id] }, desc)
    await r.write(PERSON_KEY, { shape: "outcome", r: 1, input_refs: [a.id, ans.id] })

    const schemasAfter = (await r.call(NODE_KEY, { type: "record_read", shape: "shape_schema" })) as Array<{ id: string }>
    expect(schemasAfter.map((x) => x.id)).toContain(schRes.body.id)
    const descsAfter = (await r.call(NODE_KEY, { type: "record_read", shape: "shape_description" })) as Array<{ id: string }>
    expect(descsAfter.map((x) => x.id)).toContain(descRes.body.id)
    const sharedAfter = (await r.episodes()).shared.map((x) => x.id)
    expect(sharedAfter).toContain(schRes.body.id)
    expect(sharedAfter).toContain(descRes.body.id)
  })
})

describe("Wave 1 — certainty-driven resolver graduation detector", () => {
  test("[MUST-FAIL] opens graduate-template:* at >= 8 own graded runs & >= 0.85 rate, ignores < 8 runs, and closes if rate drops < 0.85", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, { shape: "credits", target: "gap", by_call: "git_land" }, owner)
    await r.write(NODE_KEY, { shape: "credits", target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 }, owner)

    const seedGap = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-seed", status: "open" }, detector)
    const mintSel = await r.select(seedGap.id, { a: "produce/activity_template/ch1", cell: "produce/activity_template/ch1|gap" })
    const tpl = await r.write(NODE_KEY, {
      shape: "activity_template",
      sig: { in: ["gap"], out: ["gitLandResult"] },
      calls: [{ shape: "fs_edit", pointer: { path: "a.ts" } }, { shape: "git_land", pointer: {} }],
      selection_ref: mintSel.id,
      input_refs: [seedGap.id],
    }, desc)
    // A second template with 0 own runs must NOT graduate from kind-level inheritance!
    const idleTpl = await r.write(NODE_KEY, {
      shape: "activity_template",
      sig: { in: ["gap"], out: ["gitLandResult"] },
      calls: [{ shape: "fs_edit", pointer: { path: "b.ts" } }, { shape: "git_land", pointer: {} }],
      selection_ref: mintSel.id,
      input_refs: [seedGap.id],
    }, desc)

    const runLandedGap = async (idx: number) => {
      const g = await r.write(NODE_KEY, { shape: "gap", gap_id: `g-run-${idx}`, status: "open" }, detector)
      const s = await r.select(g.id, { a: `run/${tpl.id}`, cell: `run/${tpl.id}|gap,asker:detector,age:0` })
      await r.write(NODE_KEY, { shape: "hop", call_id: `c-${idx}`, phase: "started", kind: "run", pointer_type: "git_land", selection_ref: s.id, input_refs: [s.id] }, walk)
      await r.write(NODE_KEY, { shape: "hop", call_id: `c-${idx}`, phase: "ended", kind: "run", selection_ref: s.id, input_refs: [s.id] }, walk)
      await r.write(NODE_KEY, { shape: "gap", gap_id: `g-run-${idx}`, status: "closed" }, detector)
    }

    // 7 runs: below threshold -> zero graduate-template gaps
    for (let i = 1; i <= 7; i++) await runLandedGap(i)
    const gaps7 = (await r.call(NODE_KEY, { type: "record_read", shape: "gap" })) as Array<Record<string, any>>
    expect(gaps7.filter((g) => String(g.gap_id ?? "").startsWith(GRADUATE_PREFIX))).toEqual([])

    // 8th run: alpha=9, beta=1, n=8, rate=0.90 >= 0.85 -> emits open graduate-template:<tpl.id.slice(0,12)>
    await runLandedGap(8)
    const gaps8 = (await r.call(NODE_KEY, { type: "record_read", shape: "gap" })) as Array<Record<string, any>>
    const gradOpen = gaps8.filter((g) => String(g.gap_id ?? "").startsWith(GRADUATE_PREFIX))
    expect(gradOpen.length).toBe(1)
    expect(gradOpen[0]!.gap_id).toBe(`${GRADUATE_PREFIX}${tpl.id.slice(0, 12)}`)
    expect(gradOpen[0]!.status).toBe("open")
    expect(gradOpen[0]!.category).toBe("resolver_graduation")
    expect(gradOpen[0]!.severity).toBe("low")
    expect(gradOpen[0]!.repo).toBe("local-tools-vessel")
    expect(String(gradOpen[0]!.summary)).toContain(tpl.id)
    expect(gradOpen.some((g) => g.gap_id === `${GRADUATE_PREFIX}${idleTpl.id.slice(0, 12)}`)).toBe(false)

    // Two failing runs drop rate to 9 / 12 = 0.75 < 0.85 -> next terminal write closes the graduation gap
    for (let j = 1; j <= 2; j++) {
      const gFail = await r.write(NODE_KEY, { shape: "gap", gap_id: `g-fail-${j}`, status: "open" }, detector)
      const sFail = await r.select(gFail.id, { a: `run/${tpl.id}`, cell: `run/${tpl.id}|gap,asker:detector,age:0` })
      await r.write(NODE_KEY, { shape: "failure", selection_ref: sFail.id, call_id: `cf-${j}`, status: 400, body: "failed" }, walk)
      await r.write(NODE_KEY, { shape: "gap", gap_id: `g-fail-${j}`, status: "closed" }, detector)
    }
    const gapsAfterFail = (await r.call(NODE_KEY, { type: "record_read", shape: "gap" })) as Array<Record<string, any>>
    const gradRows = gapsAfterFail.filter((g) => g.gap_id === `${GRADUATE_PREFIX}${tpl.id.slice(0, 12)}`)
    expect(gradRows.map((g) => g.status)).toEqual(["open", "closed"])

    // Pure function sanity check on empty store
    expect(graduationGapsOf([])).toEqual([])
  })
})

// SPDX-License-Identifier: MIT
// Stores for calledin.test.ts: which earned templates the walk is shown in shared (store.ts earned, calledIn). Rows are
// made as store.ts write() makes them (input_refs defaulted, seq, t on a fixed clock, writer, role, then the sha256 id),
// so the same builder gives the same rows, ids and all, every run. The walk's selections and hops carry what walk-vessel
// writes (selectionRow: root, pool_refs, cands, posts, timing; calls.ts once: a started hop with kind and pointer_type,
// an ended one with kind, output and the selection in input_refs).
import type { Row } from "../../src/store"

export const WALKER = "walk-1"
const T0 = Date.parse("2026-11-02T00:00:00.000Z")

type As = { writer: string; role: string }
const walk: As = { writer: WALKER, role: "walk" }
const other: As = { writer: "walk-2", role: "walk" }
const desc: As = { writer: "described-1", role: "described" }
const owner: As = { writer: "owner", role: "owner" }
const person: As = { writer: "kid-person", role: "person" }

const store = () => {
  const rows: Row[] = []
  const add = (body: Record<string, unknown>, as: As): Row => {
    const seq = rows.length + 1
    const t = new Date(T0 + seq * 1000).toISOString()
    const unsigned = { input_refs: [], ...body, seq, t, writer: as.writer, role: as.role }
    const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(unsigned)).digest("hex")
    const row = { ...unsigned, shape: String(body.shape), id } as Row
    rows.push(row)
    return row
  }
  const select = (root: string, as: As = walk, a = "call/fs_read"): Row => {
    const cands = [{ id: a, kind: a.split("/")[0], root }, { id: `run/${"7".repeat(64)}`, kind: "run", root }, { id: `produce/answer/${"c".repeat(64)}`, kind: "produce", root }]
    return add({
      shape: "selection", arm: "treated", cands, posts: cands.map((_c, k) => ({ alpha: 1 + k * 0.5, beta: 2.43, from: "cell" })),
      posts_seq: rows.length, seed: 2718281828, a, from: "move", cell: `${a}|world_changed,asker:person,age:0`,
      context: ["world_changed", "asker:person", "age:0"], cell_scheme: "reads", root, pool_refs: [root], seen_key: "k".repeat(64),
      timing: { episodes_ms: 900, episodes_reads: 1, choices_ms: 30, posterior_ms: 10, posterior_reads: 1, draw_ms: 0, cands: 3, cells: 3 },
    }, as)
  }
  const started = (sel: Row, call: string, type: string, kind = "call", as: As = walk): Row =>
    add({ shape: "hop", call_id: call, phase: "started", kind, selection_ref: sel.id, pointer_type: type, input_refs: [sel.id],
      ...(kind === "run" ? { args: { path: "src/store.ts" }, bound: [{ from: "root" }] } : {}) }, as)
  const ended = (sel: Row, call: string, kind = "call", as: As = walk): Row =>
    add({ shape: "hop", call_id: call, phase: "ended", kind, selection_ref: sel.id, output: { ok: true, call }, input_refs: [sel.id] }, as)
  // A person's ask, the walk's answer to it, and the person's r 1 on the answer: the grade that closes the request.
  const ask = (what: string): Row => add({ shape: "world_changed", what }, person)
  const close = (root: Row, sel: Row): void => {
    const ans = add({ shape: "answer", text: `done: ${String(root.what)}`, selection_ref: sel.id, input_refs: [root.id] }, desc)
    add({ shape: "outcome", r: 1, input_refs: [ans.id] }, person)
  }
  const template = (sel: Row | string, calls: string[], name: string, as: As = desc): Row =>
    add({ shape: "activity_template", name, calls: calls.map((shape) => ({ shape })), selection_ref: typeof sel === "string" ? sel : sel.id }, as)
  return { rows, add, select, started, ended, ask, close, template }
}

const owners = (add: ReturnType<typeof store>["add"]): void => {
  add({ shape: "arm", vessel_id: WALKER, arm: "treated", as_of_seq: 1e9 }, owner)
  add({ shape: "channel", name: "answer", to: "person" }, owner)
  add({ shape: "shape_schema", target: "answer", version: 1, fields: { text: "string" } }, owner)
  add({ shape: "requires", call: "git_land", needs: "gitDiff" }, owner)
}

// Requests a person closed, each with the templates a producer extracted from them: one each that replays only through
// an ended call, an ended run, two calls in store order, and one that does not replay for each conjunct of calledIn's
// filter (a started hop that never ended, another walker's ended hop under this walker's selection, a wait_for hop, and
// a row of another shape carrying a hop's fields: test-only, no writer writes one), so dropping a conjunct changes which
// templates are shared. Beside them: templates calling what the run never called, citing a selection of a request still
// open, citing another walker's selection, an empty calls list; and last, the ended hop that makes the final template
// replay, so a read before it and a read after it differ.
export const earnedWorld = (): Row[] => {
  const { rows, add, select, started, ended, ask, close, template } = store()
  owners(add)
  const rc = ask("read the store")
  const rr = ask("run the read template")
  const ro = ask("read, then grep")
  const sc = select(rc.id)
  started(sc, "c1", "fs_read")
  const sr = select(rr.id, walk, `run/${"7".repeat(64)}`)
  const so = select(ro.id)
  started(so, "o1", "fs_read")
  ended(sc, "c1")
  started(sr, "r1", "git_diff", "run")
  ended(so, "o1")
  // another walker on the same request, its own hops: never this walker's
  const theirs = select(ro.id, other)
  started(theirs, "x1", "git_land", "call", other)
  ended(theirs, "x1", "call", other)
  started(so, "o2", "grep")
  ended(sr, "r1", "run")
  ended(so, "o2")
  close(rc, sc)
  close(rr, sr)
  close(ro, so)
  // a started hop that never ended
  const rp = ask("land it")
  const sp = select(rp.id)
  started(sp, "p1", "fs_read")
  ended(sp, "p1")
  started(sp, "p2", "git_land")
  close(rp, sp)
  // another walker's ended hop under this walker's selection, with this walker's call_id
  const rw = ask("test it")
  const sw = select(rw.id)
  started(sw, "w1", "test_run")
  ended(sw, "w1", "call", other)
  close(rw, sw)
  // a wait the walk ended: kind wait_for, not a call or a run
  const rk = ask("wait for me")
  const sk = select(rk.id, walk, "wait_for/person")
  started(sk, "k1", "person", "wait_for")
  ended(sk, "k1", "wait_for")
  close(rk, sk)
  // a row of another shape with a hop's fields (test-only)
  const rs = ask("summarise")
  const ss = select(rs.id)
  started(ss, "s1", "record_summary")
  add({ shape: "hop_echo", call_id: "s1", phase: "ended", kind: "call", selection_ref: ss.id, input_refs: [ss.id] }, walk)
  close(rs, ss)
  // a request still open, worked
  const rn = ask("not closed")
  const sn = select(rn.id)
  started(sn, "n1", "fs_read")
  ended(sn, "n1")
  // the request whose last ended hop is the store's last row
  const rl = ask("diff, then land")
  const sl = select(rl.id)
  started(sl, "l1", "git_diff")
  ended(sl, "l1")
  started(sl, "l2", "git_land")
  close(rl, sl)

  template(sc, ["fs_read"], "by-a-call")
  template(sr, ["git_diff"], "by-a-run")
  template(so, ["fs_read", "grep"], "in-order")
  template(so, ["grep", "fs_read"], "out-of-order")
  template(so, ["git_land"], "another-walkers-call")
  template(sp, ["fs_read", "git_land"], "started-never-ended")
  template(sw, ["test_run"], "ended-by-another-writer")
  template(sk, ["person"], "a-wait")
  template(ss, ["record_summary"], "another-shape")
  template(sc, ["grep"], "never-called")
  template(sn, ["fs_read"], "request-still-open")
  template(theirs, ["git_land"], "another-walkers-selection")
  template(sc, [], "no-calls")
  template(sl, ["git_diff", "git_land"], "diff-then-land")
  template(sc, ["fs_read"], "the-owners", owner)
  ended(sl, "l2")
  return rows
}

// `history` requests a person closed, each a selection with one call started and ended, and `templates` of them each
// with a template replaying it: the store grows by a row per template, and every template reaches calledIn.
export const many = (history: number, templates: number): Row[] => {
  const { rows, add, select, started, ended, ask, close, template } = store()
  owners(add)
  const sels: Row[] = []
  for (let i = 0; i < history; i++) {
    const r = ask(`old ${i}`)
    const s = select(r.id)
    started(s, `m${i}`, "fs_read")
    ended(s, `m${i}`)
    close(r, s)
    sels.push(s)
  }
  for (let i = 0; i < templates; i++) template(sels[i]!, ["fs_read"], `t${i}`)
  const open = ask("the one worked")
  const s = select(open.id)
  started(s, "now", "fs_read")
  return rows
}

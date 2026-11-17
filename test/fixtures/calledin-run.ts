// SPDX-License-Identifier: MIT
// Runs records' episodes read over calledin-rows.ts's stores (and episode-rows.ts's mixed, gaps and idle), in a process of
// its own: the store loads its rows from its data directory when imported, so each prefix is written there and the
// store imported afresh. Run by calledin.test.ts with a job file and an answer file it writes JSON to.
//   {snapshot: true}: for every prefix of each store, the episodes answer's shared ids in order, and the sha256 of each
//   read form's whole answer. Run on the parent's tree it wrote calledin-snapshot.json:
//     bun test/fixtures/calledin-run.ts <job file> test/fixtures/calledin-snapshot.json
//   {count: [history, templates]}: how many times one episodes read took an element of the store's row list, after a
//   first read (so the fold's kept grades are not what is counted), and how many templates it shared.
//   {twice: true}: the earned store less its last row, read; that row written as the walk writes it; read again.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Row } from "../../src/store"
import { WALKER, earnedWorld, many } from "./calledin-rows"
import { gaps, idle, mixed } from "./episode-rows"

type Job = { snapshot?: boolean; count?: [number, number]; twice?: boolean }
const job = JSON.parse(await Bun.file(process.argv[2]!).text()) as Job
const say = (v: unknown): void => writeFileSync(process.argv[3]!, `${JSON.stringify(v, null, 1)}\n`)
const DIR = process.env.RECORDS_DATA_DIR!
mkdirSync(DIR, { recursive: true })
const STORE = join(import.meta.dir, "..", "..", "src", "store.ts")

let fresh = 0
const load = async (rows: Row[]) => {
  writeFileSync(join(DIR, "rows"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""))
  const store = await import(`${STORE}?fresh=${++fresh}`)
  if (store.lastSeq() !== rows.length || store.rows.length !== rows.length) throw new Error(`store not loaded afresh at ${rows.length}`)
  return store as typeof import("../../src/store")
}
const sha = (v: unknown): string => new Bun.CryptoHasher("sha256").update(JSON.stringify(v)).digest("hex")
type All = { shared: Row[]; roots: Array<{ root: Row; rows: Row[]; awaits: boolean }> }
const templates = (all: All) => all.shared.filter((r) => r.shape === "activity_template").map((r) => String(r.name))

if (job.snapshot) {
  const stores: Record<string, () => Row[]> = { earned: earnedWorld, mixed, gaps, idle }
  const out: Record<string, unknown> = {}
  for (const [name, make] of Object.entries(stores)) {
    const rows = make()
    const prefixes: Record<string, unknown> = {}
    for (let n = 1; n <= rows.length; n++) {
      const store = await load(rows.slice(0, n))
      const all = store.serveRead({ episode: WALKER, roots: "all" }) as All
      const one = store.serveRead({ episode: WALKER }) as Row[]
      prefixes[n] = { shared: all.shared.map((r) => r.id), sha: { all: sha(all), one: sha(one) } }
    }
    const store = await load(rows)
    out[name] = { rows: rows.length, prefixes, templates: templates(store.serveRead({ episode: WALKER, roots: "all" }) as All) }
  }
  say(out)
} else if (job.count !== undefined) {
  const store = await load(many(job.count[0], job.count[1]))
  const list = store.rows
  store.serveRead({ episode: WALKER, roots: "all" })
  // Every element of the store's own list read through a getter that counts (episode-run.ts's wide job): what the read
  // code takes of the list, whatever form it takes it in.
  let reads = 0
  for (let i = 0; i < list.length; i++) {
    let v = list[i]
    Object.defineProperty(list, i, { get: () => { reads++; return v }, set: (x) => { v = x }, enumerable: true, configurable: true })
  }
  reads = 0
  const all = store.serveRead({ episode: WALKER, roots: "all" }) as All
  const n = reads
  say({ n: list.length, reads: n, shared_templates: templates(all).length })
} else if (job.twice) {
  const rows = earnedWorld()
  const last = rows.at(-1)!
  const store = await load(rows.slice(0, -1))
  const before = templates(store.serveRead({ episode: WALKER, roots: "all" }) as All)
  const { id: _i, seq: _s, t: _t, writer, role, ...body } = last
  const wrote = store.write(body, writer, role)
  const after = templates(store.serveRead({ episode: WALKER, roots: "all" }) as All)
  say({ last: { shape: last.shape, phase: last.phase, kind: last.kind, writer }, status: wrote.status, before, after })
}

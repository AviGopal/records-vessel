// SPDX-License-Identifier: MIT
// Runs records' episode reads (store.ts serveRead, both forms) over a fixture's rows, in a process of its own: the store
// loads its rows from its data directory when imported, so each prefix of the rows is written there and the store
// imported afresh. Run by episode-scan.test.ts with a job file and an answer file it writes JSON to (the store logs
// on stdout).
//   {fixture, prefixes}: for each prefix, each answer's sha256 and the ids it holds, and the last prefix's answers whole.
//   {wide: [history, extra]}: how many times a read took an element of the store's row list, per form, after a first
//   read of each (so the fold's kept grades are not what is counted).
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Row } from "../../src/store"
import { FIXTURES, WALKER, wide } from "./episode-rows"

//   {omit: [fixture, spec]}: for each prefix, the episodes answer without omit and with it, the no-omit answer read
//   again after it, and whether the store's rows were the same after as before.
type Job = { fixture?: string; prefixes?: number[]; wide?: [number, number]; omit?: [string, Record<string, unknown>] }
const job = JSON.parse(await Bun.file(process.argv[2]!).text()) as Job
const say = (v: unknown): void => writeFileSync(process.argv[3]!, JSON.stringify(v))
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
const idsOf = (all: All) => ({ shared: all.shared.map((r) => r.id), roots: all.roots.map((x) => ({ root: x.root.id, rows: x.rows.map((r) => r.id), awaits: x.awaits })) })

if (job.fixture !== undefined) {
  const rows = FIXTURES[job.fixture]!()
  const prefixes = job.prefixes ?? rows.map((_r, i) => i + 1)
  const out: Record<string, unknown> = {}
  let last: unknown
  for (const n of prefixes) {
    const store = await load(rows.slice(0, n))
    const one = store.serveRead({ episode: WALKER }) as Row[]
    const all = store.serveRead({ episode: WALKER, roots: "all" }) as All
    out[n] = { sha: { one: sha(one), all: sha(all) }, one: one.map((r) => r.id), all: idsOf(all) }
    last = { n, one, all }
  }
  say({ fixture: job.fixture, rows: rows.length, prefixes: out, last })
} else if (job.omit !== undefined) {
  const rows = FIXTURES[job.omit[0]]!()
  const out: unknown[] = []
  for (let n = 1; n <= rows.length; n++) {
    const store = await load(rows.slice(0, n))
    const before = JSON.stringify(store.rows)
    const plain = store.serveRead({ episode: WALKER, roots: "all" })
    const thin = store.serveRead({ episode: WALKER, roots: "all", omit: job.omit[1] } as Parameters<typeof store.serveRead>[0])
    const again = store.serveRead({ episode: WALKER, roots: "all" })
    out.push({ n, plain, thin, again: sha(again) === sha(plain), stored: JSON.stringify(store.rows) === before })
  }
  say(out)
} else if (job.wide !== undefined) {
  const rows = wide(job.wide[0], job.wide[1])
  const store = await load(rows)
  const list = store.rows
  store.serveRead({ episode: WALKER, roots: "all" })
  store.serveRead({ episode: WALKER })
  // Every element of the store's own list read through a getter that counts: what the read code takes of the list,
  // whatever form it takes it in (a loop, filter, map).
  let reads = 0
  for (let i = 0; i < list.length; i++) {
    let v = list[i]
    Object.defineProperty(list, i, { get: () => { reads++; return v }, set: (x) => { v = x }, enumerable: true, configurable: true })
  }
  reads = 0
  const all = store.serveRead({ episode: WALKER, roots: "all" }) as All
  const readsAll = reads
  reads = 0
  store.serveRead({ episode: WALKER })
  const readsOne = reads
  say({ n: list.length, roots: all.roots.length, reads_all: readsAll, reads_one: readsOne })
}

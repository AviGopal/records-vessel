// SPDX-License-Identifier: MIT
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR } from "./config"
import {
  ACTIVITY_TEMPLATE, ARM, CHANNEL, DESCRIBED, FAILURE, HOP, OWNER, PERSON, PRIOR, SELECTION, SHAPE_SCHEMA, VESSEL_KEY,
} from "./shapes"

export type Row = { shape: string; id: string; seq: number; t: string; writer: string; role: string; input_refs: string[]; [k: string]: unknown }
export type Query = {
  shape?: string
  ids?: string[]
  after_seq?: number
  refs_to?: string
  where?: Record<string, unknown>
  episode?: string
}

const OWNER_SHAPES = new Set([VESSEL_KEY, CHANNEL, SHAPE_SCHEMA, ARM, PRIOR])
const EXO_ROLES = new Set([PERSON, OWNER])
const MINE = new Set([SELECTION, HOP, FAILURE])
const FILE = join(DATA_DIR, "rows")

appendFileSync(FILE, "")
export const rows: Row[] = (await Bun.file(FILE).text())
  .split("\n")
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l) as Row)
let seq = rows.length
let wakers: Array<() => void> = []

export const write = (body: Record<string, unknown>, writer: string, role: string): { status: number; body: unknown } => {
  if (OWNER_SHAPES.has(String(body.shape))) {
    if (role !== OWNER) {
      return { status: 403, body: { failure: { status: 403, body: role } } }
    }
  }
  if (role === DESCRIBED) {
    const sels = rows.filter((r) => r.shape === SELECTION).filter((r) => r.id === String(body.selection_ref))
    const owners = sels.map((r) => r.writer)
    const keys = new Map<string, string>()
    for (const k of rows.filter((r) => r.shape === VESSEL_KEY).filter((r) => r.role === OWNER)) {
      keys.set(String(k.vessel_id), String(k.key_id))
    }
    const allowed = new Set([...keys.entries()].filter(([v]) => owners.includes(v)).map(([, k]) => k))
    if (!allowed.has(String(body.caller_key))) {
      return { status: 403, body: { failure: { status: 403, body: role } } }
    }
  }
  seq = seq + 1
  const unsigned = { input_refs: [], ...body, seq, t: new Date().toISOString(), writer, role }
  const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(unsigned)).digest("hex")
  const row: Row = { ...unsigned, shape: String(body.shape), id }
  appendFileSync(FILE, `${JSON.stringify(row)}\n`)
  rows.push(row)
  const woken = wakers
  wakers = []
  for (const f of woken) {
    f()
  }
  return { status: 200, body: row }
}

export const read = (q: Query): Row[] => {
  let out = rows
  if (q.shape !== undefined) {
    const s = String(q.shape)
    out = out.filter((r) => r.shape === s)
  }
  if (q.ids !== undefined) {
    const s = new Set(q.ids)
    out = out.filter((r) => s.has(r.id))
  }
  if (q.after_seq !== undefined) {
    const n = Number(q.after_seq)
    out = out.filter((r) => r.seq > n)
  }
  if (q.refs_to !== undefined) {
    const s = String(q.refs_to)
    out = out.filter((r) => [r.input_refs].flat().includes(s))
  }
  if (q.where !== undefined) {
    for (const [k, v] of Object.entries(q.where)) {
      const s = String(v)
      out = out.filter((r) => String(r[k]) === s)
    }
  }
  return out
}

const exogenous = (from: Row[]): Row[] =>
  from.filter((r) => EXO_ROLES.has(r.role)).filter((r) => !OWNER_SHAPES.has(r.shape))

export const episode = (w: string): Row[] => {
  const arms = rows.filter((r) => r.shape === ARM).filter((r) => r.role === OWNER).filter((r) => String(r.vessel_id) === w)
  const starts = new Set([...exogenous(rows), ...arms].map((r) => r.id))
  const [e] = rows.filter((r) => starts.has(r.id)).map((r) => r.seq).reverse().concat([0])
  const after = rows.filter((r) => r.seq > e)
  const allSels = new Set(rows.filter((r) => r.shape === SELECTION).filter((r) => r.writer === w).map((r) => r.id))
  const own = after.filter((r) => MINE.has(r.shape)).filter((r) => r.writer === w)
  const sels = new Set(own.filter((r) => r.shape === SELECTION).map((r) => r.id))
  const keep = new Set([
    ...rows.filter((r) => r.seq === e),
    ...own,
    ...after.filter((r) => r.role === DESCRIBED).filter((r) => sels.has(String(r.selection_ref))),
    ...rows.filter((r) => r.role === OWNER).filter((r) => r.shape === CHANNEL),
    ...rows.filter((r) => r.role === OWNER).filter((r) => r.shape === SHAPE_SCHEMA),
    ...rows.filter((r) => r.shape === ACTIVITY_TEMPLATE).filter((r) => r.role === DESCRIBED)
      .filter((r) => allSels.has(String(r.selection_ref))),
  ].map((r) => r.id))
  return rows.filter((r) => keep.has(r.id))
}

const until = async (scan: () => Row[]): Promise<Row> => {
  const hits = scan()
  if (hits.length > 0) {
    return hits[0]
  }
  await new Promise<void>((resolve) => {
    wakers.push(resolve)
  })
  return until(scan)
}

export const wait = (shapes: string[], afterSeq: number): Promise<Row> =>
  until(() => {
    const after = rows.filter((r) => r.seq > afterSeq)
    const want = new Set(shapes)
    const hits = new Set([...after.filter((r) => want.has(r.shape)), ...exogenous(after)].map((r) => r.id))
    return after.filter((r) => hits.has(r.id))
  })

export const waitExact = (shapes: string[], afterSeq: number, where: Record<string, unknown> | undefined): Promise<Row> =>
  until(() => {
    const want = new Set(shapes)
    return read({ after_seq: afterSeq, where }).filter((r) => want.has(r.shape))
  })

export const lastSeq = (): number => seq

export const serveRead = (q: Query): Row[] => {
  if (q.episode !== undefined) {
    return episode(q.episode)
  }
  return read(q)
}

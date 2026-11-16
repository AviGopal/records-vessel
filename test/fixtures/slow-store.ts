// SPDX-License-Identifier: MIT
// A store whose posterior fold takes seconds, for the fold worker's vessel tests: the owner's gap-credit rule, many
// treated selections each holding a wide pool, and many gap closures (gapClosuresOf weighs closures × selections × refs).
export const slowRows = (selections: number, pool: number, closures: number): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = []
  let seq = 0
  const add = (r: Record<string, unknown>) => out.push({ input_refs: [], t: "", ...r, seq: ++seq, id: `row-${seq}` })
  add({ shape: "credits", role: "owner", writer: "owner", target: "gap", by_call: "git_land" })
  add({ shape: "arm", role: "owner", writer: "owner", vessel_id: "walk", arm: "treated", as_of_seq: 1e9 })
  const open: string[] = []
  for (let g = 0; g < closures; g++) {
    add({ shape: "gap", role: "detector", writer: "detector", gap_id: `g${g}`, status: "open" })
    open.push(String(out[out.length - 1]!.id))
  }
  for (let s = 0; s < selections; s++) {
    const refs = Array.from({ length: pool }, (_, i) => `ref-${(s * 7 + i) % 5000}`)
    refs.push(open[s % open.length]!)
    add({ shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: `call/x|c${s % 50}`, a: "call/x", pool_refs: refs })
  }
  for (let g = 0; g < closures; g++) add({ shape: "gap", role: "detector", writer: "detector", gap_id: `g${g}`, status: "closed" })
  return out
}

// SPDX-License-Identifier: MIT
import { drainRefolds } from "./fold"

// A request whose answer refolded grades over the whole store (a cache miss: the store moved since the last fold) says
// so, with what it cost: such a fold takes seconds and is what makes a reader wait or time out, and without this line no
// one can tell which read it was. A request that folded nothing writes no line.
export const costed = <T>(shape: string, query: unknown, run: () => T, log: (line: string) => void = console.log): T => {
  drainRefolds()
  const t0 = performance.now()
  const v = run()
  const folds = drainRefolds()
  if (folds.length > 0) {
    const each = folds.map((f) => `${f.fold} ${f.ms} ms`).join(", ")
    log(`[records] ${shape} took ${Math.round(performance.now() - t0)} ms; refolded ${each} over ${folds[0]!.rows} rows; query ${JSON.stringify(query).slice(0, 200)}`)
  }
  return v
}

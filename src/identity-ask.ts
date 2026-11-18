// SPDX-License-Identifier: MIT
// Identity's answers, kept a short while, with one ask in flight per credential. Identity limits how often one host may
// ask it, and a page load fans out into many calls carrying the same credential: asked once each, the burst crosses the
// limit, identity answers 429, and every caller then refuses. Here a burst asks once: a caller arriving while an ask for
// its credential is in flight waits for that answer, and two credentials never share one.
// Kept (constants, not yet shaped rows: named debt agf_naph2ibbhxbz; each becomes an owner tuning row, these values its
// fallback, once this vessel reads one at use time):
// - a "no" (identity answered and did not authenticate, or said 401/403) for NO_MS: a refused credential asked again at
//   once would only be refused again;
// - a "yes" only where the caller asks for it, for YES_MS at most, and never past the expiry identity states for it;
// - nothing transient (a 429, a 5xx, no answer): it is shared only by the asks in flight when it came, so one blip is
//   never served as a refusal to the asks after it.
// A fresh ask (a write: a key's class must count from the next write) reads nothing kept, and still joins an ask in
// flight, which is identity answering now.
// One copy per repo (records, concept-db, the federation transport), the same rules in each; they move into one shared
// package when a fourth caller needs them.
export type Verdict<T> = { yes: T } | { no: true } | { transient: true }

export const NO_MS = 5_000
export const YES_MS = 30_000
const MAX_KEPT = 1024

export type Ask<T> = (
  key: string,
  ask: () => Promise<Verdict<T>>,
  o?: { fresh?: boolean; keepYes?: boolean; yesUntil?: (v: T) => number | undefined },
) => Promise<Verdict<T>>

export const keeper = <T>(now: () => number = Date.now): Ask<T> => {
  const kept = new Map<string, { v: Verdict<T>; until: number }>()
  const flying = new Map<string, Promise<Verdict<T>>>()
  const keep = (key: string, v: Verdict<T>, until: number) => {
    if (until <= now()) return
    kept.delete(key) // a key kept again goes to the back, and never evicts another to make room for itself
    if (kept.size >= MAX_KEPT) {
      for (const [k, e] of kept) if (e.until <= now()) kept.delete(k)
      while (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value as string)
    }
    kept.set(key, { v, until })
  }
  return async (key, ask, o = {}) => {
    if (o.fresh !== true) {
      const k = kept.get(key)
      if (k !== undefined && k.until > now()) return k.v
      if (k !== undefined) kept.delete(key)
    }
    const f = flying.get(key)
    if (f !== undefined) return f
    const p = ask()
      .then((v) => {
        if ("no" in v) keep(key, v, now() + NO_MS)
        else if ("yes" in v && o.keepYes === true) {
          const stated = o.yesUntil?.(v.yes)
          // a yes whose expiry identity does not state is not kept: it could outlive what it answers for
          if (o.yesUntil === undefined || (stated !== undefined && Number.isFinite(stated))) {
            keep(key, v, Math.min(now() + YES_MS, stated ?? Number.POSITIVE_INFINITY))
          }
        }
        return v
      })
      .finally(() => flying.delete(key))
    flying.set(key, p)
    return p
  }
}

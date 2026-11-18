// SPDX-License-Identifier: MIT
// Identity's answers, kept a short while, with one ask in flight per credential (src/identity-ask.ts): a burst asks once,
// a "no" is kept NO_MS, a "yes" only where asked for and never past its stated expiry, nothing transient is kept, a fresh
// ask reads nothing kept but joins an ask in flight, and two credentials never share an answer.
import { describe, expect, test } from "bun:test"
import { keeper, NO_MS, type Verdict, YES_MS } from "../src/identity-ask"

const clock = () => {
  let t = 1_000_000
  return { now: () => t, at: (ms: number) => { t = 1_000_000 + ms } }
}
// An ask whose answer the test releases; counts how often identity was asked.
const held = <T>() => {
  let asks = 0
  const waiting: Array<(v: Verdict<T>) => void> = []
  const failing: Array<(e: Error) => void> = []
  return {
    ask: () => { asks++; return new Promise<Verdict<T>>((res, rej) => { waiting.push(res); failing.push(rej) }) },
    answer: (v: Verdict<T>) => { for (const r of waiting.splice(0)) r(v); failing.splice(0) },
    fail: (e: Error) => { for (const r of failing.splice(0)) r(e); waiting.splice(0) },
    asks: () => asks,
  }
}

describe("one ask in flight per credential", () => {
  test("[MUST-FAIL] a burst for one credential asks identity once; every caller gets its answer", async () => {
    const c = clock(); const k = keeper<string>(c.now); const h = held<string>()
    const all = Promise.all([1, 2, 3].map(() => k("key:a", h.ask)))
    h.answer({ yes: "kid-a" })
    expect(await all).toEqual([{ yes: "kid-a" }, { yes: "kid-a" }, { yes: "kid-a" }])
    expect(h.asks()).toBe(1)
  })
  test("[MUST-FAIL] two credentials never share an ask or an answer", async () => {
    const k = keeper<string>(); const a = held<string>(); const b = held<string>()
    const pa = k("key:a", a.ask); const pb = k("key:b", b.ask)
    a.answer({ yes: "kid-a" }); b.answer({ no: true })
    expect([await pa, await pb]).toEqual([{ yes: "kid-a" }, { no: true }])
    expect([a.asks(), b.asks()]).toEqual([1, 1])
  })
  test("[MUST-FAIL] an ask that throws throws to every caller waiting on it, and is not kept", async () => {
    const k = keeper<string>(); const h = held<string>()
    const all = Promise.allSettled([k("key:a", h.ask), k("key:a", h.ask)])
    h.fail(new Error("no answer"))
    expect((await all).map((r) => r.status)).toEqual(["rejected", "rejected"])
    const again = k("key:a", h.ask); h.answer({ no: true }); await again
    expect(h.asks()).toBe(2)
  })
})

describe("what is kept, and for how long", () => {
  test("[MUST-FAIL] a no is kept NO_MS, then asked again", async () => {
    const c = clock(); const k = keeper<string>(c.now); let asks = 0
    const ask = async (): Promise<Verdict<string>> => { asks++; return { no: true } }
    await k("key:a", ask)
    c.at(NO_MS - 1); expect(await k("key:a", ask)).toEqual({ no: true })
    expect(asks).toBe(1)
    c.at(NO_MS); await k("key:a", ask)
    expect(asks).toBe(2)
  })
  test("[MUST-FAIL] a transient answer is shared by the asks in flight only, never kept", async () => {
    const c = clock(); const k = keeper<string>(c.now); const h = held<string>()
    const two = Promise.all([k("key:a", h.ask), k("key:a", h.ask)])
    h.answer({ transient: true })
    expect(await two).toEqual([{ transient: true }, { transient: true }])
    const next = k("key:a", h.ask); h.answer({ no: true }); await next
    expect(h.asks()).toBe(2)
  })
  test("[MUST-FAIL] a yes is kept only where asked for", async () => {
    const c = clock(); const k = keeper<string>(c.now); let asks = 0
    const ask = async (): Promise<Verdict<string>> => { asks++; return { yes: "kid-a" } }
    await k("key:a", ask); await k("key:a", ask)
    expect(asks).toBe(2)
    await k("key:b", ask, { keepYes: true }); await k("key:b", ask, { keepYes: true })
    expect(asks).toBe(3)
  })
  test("[MUST-FAIL] a kept yes lives YES_MS at most, and never past the expiry stated for it; one with none stated is not kept", async () => {
    const c = clock(); const k = keeper<string>(c.now); let asks = 0
    const ask = async (): Promise<Verdict<string>> => { asks++; return { yes: "t" } }
    await k("a", ask, { keepYes: true })
    c.at(YES_MS - 1); await k("a", ask, { keepYes: true }); expect(asks).toBe(1)
    c.at(YES_MS); await k("a", ask, { keepYes: true }); expect(asks).toBe(2)
    c.at(0)
    const stated = { keepYes: true, yesUntil: () => 1_000_000 + 2_000 }
    await k("b", ask, stated); c.at(1_999); await k("b", ask, stated); expect(asks).toBe(3)
    c.at(2_000); await k("b", ask, stated); expect(asks).toBe(4)
    const none = { keepYes: true, yesUntil: () => undefined }
    await k("c", ask, none); await k("c", ask, none); expect(asks).toBe(6)
    const past = { keepYes: true, yesUntil: () => 0 }
    await k("d", ask, past); await k("d", ask, past); expect(asks).toBe(8)
  })
  test("[MUST-FAIL] a yes whose stated expiry is further off than YES_MS is still kept YES_MS at most", async () => {
    // identity mints tokens for 60 s by default and up to 120 s: the cap, not the token's life, bounds a reused yes
    const c = clock(); const k = keeper<string>(c.now); let asks = 0
    const ask = async (): Promise<Verdict<string>> => { asks++; return { yes: "t" } }
    const long = { keepYes: true, yesUntil: () => 1_000_000 + 60_000 }
    await k("e", ask, long)
    c.at(YES_MS - 1); await k("e", ask, long); expect(asks).toBe(1)
    c.at(YES_MS); await k("e", ask, long); expect(asks).toBe(2)
  })
  test("[MUST-FAIL] a fresh ask reads nothing kept, but joins an ask in flight", async () => {
    const c = clock(); const k = keeper<string>(c.now); const h = held<string>()
    const first = k("key:a", h.ask); h.answer({ no: true }); await first
    const fresh = k("key:a", h.ask, { fresh: true })
    const joined = k("key:a", h.ask, { fresh: true })
    h.answer({ yes: "kid-a" })
    expect([await fresh, await joined]).toEqual([{ yes: "kid-a" }, { yes: "kid-a" }])
    expect(h.asks()).toBe(2)
  })
  test("[MUST-FAIL] an answer already past its expiry is not kept: it neither replaces a live one nor takes a place in a full map", async () => {
    const c = clock(); const k = keeper<string>(c.now); let asks = 0
    const answer = (v: Verdict<string>) => async (): Promise<Verdict<string>> => { asks++; return v }
    await k("a", answer({ yes: "live" }), { keepYes: true, yesUntil: () => 1_000_000 + 10_000 })
    await k("a", answer({ yes: "spent" }), { fresh: true, keepYes: true, yesUntil: () => 1_000_000 - 1 })
    expect(await k("a", answer({ yes: "new" }), { keepYes: true, yesUntil: () => 1_000_000 + 10_000 })).toEqual({ yes: "live" })
    expect(asks).toBe(2)
    const full = keeper<string>(c.now); let n = 0
    const no = async (): Promise<Verdict<string>> => { n++; return { no: true } }
    for (let i = 0; i < 1024; i++) await full(`key:${i}`, no)
    await full("spent", async () => ({ yes: "t" }), { keepYes: true, yesUntil: () => 1_000_000 - 1 })
    await full("key:0", no); expect(n).toBe(1024)               // still kept: the spent answer evicted nothing
  })
  test("a full map drops what has expired before it evicts a live answer (a guard)", async () => {
    const c = clock(); const k = keeper<string>(c.now); let yes = 0
    const live = async (): Promise<Verdict<string>> => { yes++; return { yes: "t" } }
    const no = async (): Promise<Verdict<string>> => ({ no: true })
    for (let i = 0; i < 1023; i++) await k(`key:${i}`, live, { keepYes: true }) // kept YES_MS
    await k("dead", no)                                          // kept NO_MS, the newest in the map
    c.at(NO_MS)                                                  // "dead" has expired; the map is still full
    await k("another", no)                                       // room is made by dropping "dead", not "key:0"
    await k("key:0", live, { keepYes: true }); expect(yes).toBe(1023)
  })
  test("a no is kept 5 s and a yes 30 s at most (the named-debt bounds, agf_naph2ibbhxbz, a guard)", () => {
    expect([NO_MS, YES_MS]).toEqual([5_000, 30_000])
  })
  test("at most 1024 answers are kept: past that the oldest goes first (a guard)", async () => {
    const c = clock(); const k = keeper<string>(c.now); let asks = 0
    const ask = async (): Promise<Verdict<string>> => { asks++; return { no: true } }
    for (let i = 0; i <= 1024; i++) await k(`key:${i}`, ask)
    expect(asks).toBe(1025)
    await k("key:1024", ask); expect(asks).toBe(1025)   // the newest is still kept
    await k("key:0", ask); expect(asks).toBe(1026)      // the oldest went
  })
  test("[MUST-FAIL] a key kept again in a full map evicts no other key, and becomes the newest", async () => {
    const c = clock(); const k = keeper<string>(c.now); let asks = 0
    const ask = async (): Promise<Verdict<string>> => { asks++; return { no: true } }
    for (let i = 0; i < 1024; i++) await k(`key:${i}`, ask)
    await k("key:5", ask, { fresh: true })                 // asked again and kept again: no room needed
    await k("key:0", ask); expect(asks).toBe(1025)          // still kept
    await k("key:1024", ask); expect(asks).toBe(1026)        // the map is full: the oldest (key:0) goes, not key:5
    await k("key:5", ask); await k("key:1", ask); expect(asks).toBe(1026)
    await k("key:0", ask); expect(asks).toBe(1027)
  })
})

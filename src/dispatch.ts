// SPDX-License-Identifier: MIT
// One call to a handler, and what its throw means. A refusal of what the caller asked, thrown from inside a handler
// (Refused), is the caller's: 400. Any other throw is records failing, not the caller: 500, so the caller's move is not
// blamed for it, and said in the journal by shape, error name and where it was thrown: never the error's message, never
// the pointer's values. The handlers are passed in, so a test can give one that throws.
export class Refused extends Error {}

export const dispatch = async <P extends { type: string }, W>(p: P, who: W, handlers: Map<string, (p: P, who: W) => Promise<Response>>): Promise<Response> => {
  const h = handlers.get(p.type)
  if (h === undefined) return Response.json({ failure: { status: 400, body: p.type } }, { status: 400 })
  try {
    return await h(p, who)
  } catch (e) {
    if (e instanceof Refused) return Response.json({ failure: { status: 400, body: String(e) } }, { status: 400 })
    // The error's name and where it was thrown, never its message: a fault inside the store can echo row content (a
    // person's text) through a parse or type error's message (qa).
    const name = e instanceof Error ? e.name : typeof e
    const at = e instanceof Error ? /\(?([^\s()]+:\d+):\d+\)?$/m.exec((e.stack ?? "").split("\n").find((l) => /^\s+at /.test(l)) ?? "")?.[1] : undefined
    console.error(`[records] ${p.type} failed: ${name}${at ? ` at ${at}` : ""}`)
    return Response.json({ failure: { status: 500, body: `${p.type} failed: ${name}` } }, { status: 500 })
  }
}

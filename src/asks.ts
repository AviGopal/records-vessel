// SPDX-License-Identifier: MIT
// WHAT AN ASK IS: one predicate for every reader that asks it (the open roots, the deadline rule's lapses, the lapses a
// grader is shown, a promise's exemption), so a row is an ask to all of them or to none.
import { ACTIVITY_TEMPLATE, ARM, CHANNEL, CREDITS, FAILURE_RULE, HOLD_FACT, INFRA_WINDOW, OPERATOR, OUTCOME, OWNER, PERSON, PRIOR, REPOSITORY, REQUIRES, RHYTHM, SHAPE_DESCRIPTION, SHAPE_SCHEMA } from "./shapes"
import type { Row } from "./store"

export const OWNER_SHAPES = new Set([CHANNEL, SHAPE_SCHEMA, SHAPE_DESCRIPTION, ARM, PRIOR, REQUIRES, CREDITS, REPOSITORY, RHYTHM, FAILURE_RULE, INFRA_WINDOW, HOLD_FACT])
// Whose rows are asks and what the walk answers (the roots, what wakes a wait, whose deadlines lapse): a person's, the
// owner's, and an operator's. Only a person's are verdicts (store.ts closed, earned).
export const EXO_ROLES = new Set([PERSON, OWNER, OPERATOR])

// A template is configuration whoever wrote it (the owner seeds a rhythm's; the walk's plan writers write their own), never
// an ask.
export const exogenous = (from: Row[]): Row[] =>
  from.filter((r) => EXO_ROLES.has(r.role)).filter((r) => !OWNER_SHAPES.has(r.shape) && r.shape !== ACTIVITY_TEMPLATE)

// A row that carries a verdict (r 0 or 1 on rows it cites) judges something: it is a grade, whatever its shape, not a
// request. A person's verdict on a change (a land_verdict citing its diff) is one; were it a root, nothing would ever
// close it, since what closes a request is a grade of an answer to it.
export const verdict = (r: Row): boolean => (r.r === 0 || r.r === 1) && [r.input_refs].flat().filter((x) => x !== undefined).length > 0

// WHAT AN ASK IS, AS THE OWNER DECLARES IT: a shape some owner schema marks as the input it answers (an inputs entry
// {shape, ask: true}: the request schema's world_changed). Read from the newest owner schema of each target and variant,
// so nothing here names a shape. Once any is declared, an ask is an exogenous row of a declared ask shape, and every
// other owner row is the owner's configuration, shared with the walk. With none declared, any exogenous row of a shape
// outside the owner's configuration list is one, and only the listed shapes are shared.
export const declaredAsks = (from: Row[]): Set<string> | undefined => {
  const newest = new Map<string, Row>()
  for (const r of from.filter((x) => x.shape === SHAPE_SCHEMA && x.role === OWNER).sort((a, b) => a.seq - b.seq)) {
    newest.set(`${String(r.target)}|${String(r.variant ?? "")}`, r)
  }
  const out = new Set<string>()
  for (const s of newest.values()) {
    for (const e of [s.inputs ?? []].flat()) {
      const o = typeof e === "object" && e !== null ? e as { shape?: unknown; ask?: unknown } : undefined
      if (o?.ask === true && typeof o.shape === "string") out.add(o.shape)
    }
  }
  return out.size > 0 ? out : undefined
}

// A row is an ask when it is one as declared (or, undeclared, exogenous and not configuration) and it judges nothing:
// an outcome or any other verdict a person wrote is a grade of the work, never a request for it. A deadline citing a
// person's Wrong is still that request's deadline, not a deadline of the Wrong, so the Wrong never lapses as an ask.
export const isAsk = (r: Row | undefined, declared: Set<string> | undefined): boolean =>
  r !== undefined && r.shape !== OUTCOME && !verdict(r) &&
  (declared === undefined ? exogenous([r]).length > 0 : EXO_ROLES.has(r.role) && declared.has(r.shape))

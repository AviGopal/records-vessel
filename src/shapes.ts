// SPDX-License-Identifier: MIT
export const RECORD_WRITE = "record_write"
export const RECORD_READ = "record_read"
// Counts of what rows of one shape hold, never the rows (summary.ts): the only read records declares to schema-filling
// callers.
export const RECORD_SUMMARY = "record_summary"
export const RECORD_WAIT = "record_wait"
export const RECORD_WAIT_EXACT = "record_wait_exact"
export const POSTERIOR = "posterior"
export const RECORD_LAPSED = "record_lapsed"
export const ACTIVITY_TEMPLATE = "activity_template"
export const SELECTION = "selection"
export const HOP = "hop"
export const FAILURE = "failure"
export const OUTCOME = "outcome"
// A grade of a landing (git_land reads it), and the diff of the tree it judges (the walk records it from git_diff).
export const LAND_VERDICT = "land_verdict"
export const GIT_DIFF = "gitDiff"
export const PRIOR = "prior"
export const CHANNEL = "channel"
export const SHAPE_SCHEMA = "shape_schema"
// The owner's description of a shape that something other than a producer writes (a detector's gap): configuration, read
// by whoever reads that shape, never work for the walk.
export const SHAPE_DESCRIPTION = "shape_description"
// The owner's precondition on a call: the shape it names is called only when the root holds a row its needs and where
// describe. Configuration, read by the walk where it chooses, never work.
export const REQUIRES = "requires"
// The owner's rule for crediting work no one grades: {target, by_call}. A detector closing a row of the target shape
// credits the walk's steps on it only when a call of by_call ended among them first (fold.ts gapClosures). Configuration,
// never work.
export const CREDITS = "credits"
// The owner's row for a repository this fleet holds: {repo, units, roles, retired}, the latest per repo its state.
// Configuration every root's work is shown (the change_wanted judge reads it), never work for the walk.
export const REPOSITORY = "repository"
// The owner's schedule for a template the walk runs when due (the USER: "Build the schedule reader first").
export const RHYTHM = "rhythm"
// The owner's thresholds for a detector that files classes of failure as gaps (how many, over how many roots, within
// how many rows, quiet for how many rows to close, and whether it writes at all): configuration a detector reads.
export const FAILURE_RULE = "failure_rule"
// The owner's mark that a span of the store was an outage: failures of the classes it names, inside it, debit no one.
export const INFRA_WINDOW = "infra_window"
// A detector's observation that a check failed or stopped failing.
export const GAP = "gap"
// Who writes a gap: a check the node runs (pull-sync's failing-test generator among them), under the node's own key.
export const DETECTOR = "detector"
export const ARM = "arm"
export const AUTHENTICATION = "authentication"
export const WALK = "walk"
export const RECORDS = "records"
export const DESCRIBED = "described"
export const PERSON = "person"
// A key identity marks as an operator's: its rows are asks and evidence like a person's, never a person's verdict.
export const OPERATOR = "operator"
// A key identity validates and marks as neither a person's nor an operator's (unclassified, a peer's, or one it says
// nothing of): its rows are stored and read like any, but are no ask, no root, no waker and no evidence, until identity
// marks the key.
export const UNMARKED = "unmarked"
export const OWNER = "owner"
// A key identity marks as another node's (issued when that node joined, named for it): the node's own key, held by every
// vessel there, as this node's own key is held by every vessel here.
export const PEER = "peer"
export const TREATED = "treated"

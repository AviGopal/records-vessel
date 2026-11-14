// SPDX-License-Identifier: MIT
export const RECORD_WRITE = "record_write"
export const RECORD_READ = "record_read"
export const RECORD_WAIT = "record_wait"
export const RECORD_WAIT_EXACT = "record_wait_exact"
export const POSTERIOR = "posterior"
export const RECORD_LAPSED = "record_lapsed"
export const ACTIVITY_TEMPLATE = "activity_template"
export const SELECTION = "selection"
export const HOP = "hop"
export const FAILURE = "failure"
export const OUTCOME = "outcome"
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

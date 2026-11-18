// SPDX-License-Identifier: MIT
// What an on-behalf-of token's kept answer is kept under: the token (by its digest), the node it was bound to and the
// shape being served. A yes for one node answers no other: the transport's peer id is read again every minute, and an
// answer kept for the old one is never served for the new one, which would refuse it on the binding instead of asking.
export const oboKeyOf = (tokenDigest: string, node: string, shape: string): string => `obo:${tokenDigest}:${node}:${shape}`

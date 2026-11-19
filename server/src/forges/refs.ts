/**
 * The one place a ref name Lamplighter may write is constructed. `OwnBranch` can only be built
 * through `ownBranch()`, which forces the `lamplighter/` prefix, so deleting or pushing somebody
 * else's branch does not compile, and a crafted string is refused at runtime as well.
 */
declare const brand: unique symbol
export type OwnBranch = string & { readonly [brand]: 'OwnBranch' }

export const OWN_PREFIX = 'lamplighter/'
const OWN_RE = /^lamplighter\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/

export function ownBranch(check: string, slug: string, date: Date, id: string): OwnBranch {
  const day = date.toISOString().slice(0, 10).replace(/-/g, '')
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change'
  return asOwnBranch(`${OWN_PREFIX}${check}/${clean}-${day}-${id.slice(-6)}`)
}

export function asOwnBranch(name: string): OwnBranch {
  if (!OWN_RE.test(name)) throw new Error(`refusing to treat "${name}" as a Lamplighter branch`)
  return name as OwnBranch
}

export function isOwnBranch(name: string): boolean {
  return OWN_RE.test(name)
}

/** The commit trailer that marks Lamplighter's own work, so it never triggers a round. */
export const TRAILER_ROUND = 'Lamplighter-Round'
export const TRAILER_CHECK = 'Lamplighter-Check'

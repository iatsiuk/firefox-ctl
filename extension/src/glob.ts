// URL globs, shared by the background wait and anything else matching a URL
// the CLI supplied.

/**
 * Anchored regex for a URL glob: every regex metacharacter is a literal and
 * `*` matches anything. `?` is escaped too, so a glob may
 * carry a query string.
 */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`)
}

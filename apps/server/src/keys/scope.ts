/** Domain error for scope violations (read-only or out-of-scope mutations). */
export class ScopeError extends Error {}

/** API key scope: namespace prefix and write permission. */
export interface Scope {
  /** Vault path prefix (e.g., "myai/" or "" for all paths). */
  namespace: string;
  /** Whether mutations are allowed. */
  canWrite: boolean;
}

/**
 * Check if a path is within scope using case-sensitive prefix matching.
 *
 * Empty namespace matches all paths. Otherwise, a path is in scope if it
 * equals the namespace or starts with it. Matching is case-sensitive
 * (e.g., "myai/" does NOT match "MYAI/x.md").
 *
 * Note: Namespaces follow the convention of ending with "/" (or being empty)
 * to avoid unintended partial-segment matches (e.g., "my" would not match
 * "myai/x.md" if the namespace did not end with "/").
 *
 * @param scope Scope to test.
 * @param path Path to check.
 * @returns true if path is in scope, false otherwise.
 */
export function isPathInScope(scope: Scope, path: string): boolean {
  if (scope.namespace === "") return true;
  return path === scope.namespace || path.startsWith(scope.namespace);
}

/**
 * Assert that a path can be written to under the given scope.
 *
 * Throws ScopeError if the scope is read-only or the path is out of scope.
 *
 * @param scope Scope to check.
 * @param path Path to write to.
 * @throws ScopeError if path cannot be written under this scope.
 */
export function assertWritable(scope: Scope, path: string): void {
  if (!scope.canWrite) {
    throw new ScopeError("Scope is read-only, write not permitted");
  }
  if (!isPathInScope(scope, path)) {
    throw new ScopeError("Path is not in scope");
  }
}

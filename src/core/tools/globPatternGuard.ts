/** Defensive input bound for pattern parsers with recursive brace walkers.
 * Defense-in-depth only: this does not cure vulnerable transitive dependencies.
 */
export function validateGlobPattern(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('Glob pattern must be a non-empty string at most 2048 characters long');
  }
  let depth = 0;
  let escaped = false;
  for (const c of value) {
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '{') {
      depth++;
      if (depth > 12) throw new Error('Glob brace nesting exceeds the safe limit of 12');
    } else if (c === '}') {
      depth--;
      if (depth < 0) throw new Error('Glob pattern contains an unmatched closing brace');
    }
  }
  if (depth !== 0) throw new Error('Glob pattern contains an unmatched opening brace');
  return value;
}

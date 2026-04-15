import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type ValidationResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/**
 * Validate a workdir path:
 *   1. Resolves to absolute (prevents `..` escape tricks before whitelist check).
 *   2. Exists.
 *   3. Is a directory.
 *   4. If whitelist is non-empty, path starts with at least one whitelist entry.
 *
 * Whitelist entries are compared as prefix strings after both are resolved.
 */
export function validateWorkdir(
  path: string,
  whitelist: readonly string[] | undefined,
): ValidationResult {
  const absolute = resolve(path);

  if (!existsSync(absolute)) {
    return { ok: false, error: `Path not found: ${absolute}` };
  }
  try {
    if (!statSync(absolute).isDirectory()) {
      return { ok: false, error: `Not a directory: ${absolute}` };
    }
  } catch (err) {
    return { ok: false, error: `Cannot stat: ${(err as Error).message}` };
  }

  if (whitelist && whitelist.length > 0) {
    const allowed = whitelist.map((p) => resolve(p));
    const matches = allowed.some((prefix) => {
      if (absolute === prefix) return true;
      return absolute.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
    });
    if (!matches) {
      return { ok: false, error: `Path not allowed by TL_WORKSPACES_ALLOWED: ${absolute}` };
    }
  }

  return { ok: true, resolved: absolute };
}

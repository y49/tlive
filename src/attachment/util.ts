// src/attachment/util.ts
//
// Shared helpers for attachment storage + ingest. Keeps filename sanitization
// rules in one place so security-relevant changes (e.g., adding Windows
// reserved chars) land in both write paths simultaneously.

/**
 * Strip characters that can escape the target directory or break path
 * handling on common filesystems. Current policy: POSIX-focused (Linux/macOS
 * daemon runtime); Windows chars <>|?*" are NOT stripped — deferred
 * until the daemon explicitly supports native Windows builds.
 *
 * Also caps length at 200 bytes to stay well under the ext4 255-byte cap
 * (timestamp/id prefixes added by callers push the final filename closer to
 * the limit) and strips leading dots so the basename can't express `..`
 * traversal even after separators are escaped.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:\0]/g, '_').replace(/^\.+/, '_').slice(0, 200);
}

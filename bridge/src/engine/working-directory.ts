import { existsSync, statSync } from 'node:fs';

export type WorkingDirectorySource = 'session' | 'defaultWorkdir' | 'process.cwd';
export type WorkingDirectoryReason =
  | 'valid'
  | 'missing'
  | 'non-string'
  | 'empty'
  | 'non-absolute'
  | 'nonexistent'
  | 'not-directory'
  | 'root-path';

export interface WorkingDirectoryResolution {
  effectiveWorkdir: string;
  source: WorkingDirectorySource;
  healingOccurred: boolean;
  reason: WorkingDirectoryReason;
  storedWorkdir?: string;
}

function validateCandidate(candidate: unknown, defaultWorkdir: string): { valid: boolean; reason: WorkingDirectoryReason } {
  if (candidate === undefined || candidate === null) return { valid: false, reason: 'missing' };
  if (typeof candidate !== 'string') return { valid: false, reason: 'non-string' };
  const trimmed = candidate.trim();
  if (!trimmed) return { valid: false, reason: 'empty' };
  if (!trimmed.startsWith('/')) return { valid: false, reason: 'non-absolute' };
  if (trimmed === '/' && defaultWorkdir !== '/') return { valid: false, reason: 'root-path' };
  if (!existsSync(trimmed)) return { valid: false, reason: 'nonexistent' };
  try {
    if (!statSync(trimmed).isDirectory()) return { valid: false, reason: 'not-directory' };
  } catch {
    return { valid: false, reason: 'nonexistent' };
  }
  return { valid: true, reason: 'valid' };
}

export function resolveWorkingDirectory(input: {
  sessionWorkdir?: unknown;
  defaultWorkdir: string;
  processWorkdir?: string;
}): WorkingDirectoryResolution {
  const storedWorkdir = typeof input.sessionWorkdir === 'string' ? input.sessionWorkdir : undefined;
  const sessionValidation = validateCandidate(input.sessionWorkdir, input.defaultWorkdir);
  if (sessionValidation.valid) {
    return {
      effectiveWorkdir: input.sessionWorkdir as string,
      source: 'session',
      healingOccurred: false,
      reason: 'valid',
      storedWorkdir,
    };
  }

  const defaultValidation = validateCandidate(input.defaultWorkdir, input.defaultWorkdir);
  if (defaultValidation.valid) {
    return {
      effectiveWorkdir: input.defaultWorkdir,
      source: 'defaultWorkdir',
      healingOccurred: true,
      reason: sessionValidation.reason,
      storedWorkdir,
    };
  }

  const fallbackProcessWorkdir = input.processWorkdir ?? process.cwd();
  const processValidation = validateCandidate(fallbackProcessWorkdir, input.defaultWorkdir);
  if (processValidation.valid) {
    return {
      effectiveWorkdir: fallbackProcessWorkdir,
      source: 'process.cwd',
      healingOccurred: true,
      reason: sessionValidation.reason,
      storedWorkdir,
    };
  }

  return {
    effectiveWorkdir: fallbackProcessWorkdir,
    source: 'process.cwd',
    healingOccurred: true,
    reason: sessionValidation.reason,
    storedWorkdir,
  };
}

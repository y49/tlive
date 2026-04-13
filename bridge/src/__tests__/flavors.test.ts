import { describe, it, expect } from 'vitest';
import {
  Flavors, Capabilities, isKnownFlavor, hasCapability,
  getFlavorLabel, supportsModelChange, supportsEffort, supportsLiveSession,
} from '../flavors.js';

describe('flavors', () => {
  it('recognizes claude and codex as known flavors', () => {
    expect(isKnownFlavor('claude')).toBe(true);
    expect(isKnownFlavor('codex')).toBe(true);
    expect(isKnownFlavor('bogus')).toBe(false);
    expect(isKnownFlavor(null)).toBe(false);
    expect(isKnownFlavor(undefined)).toBe(false);
  });

  it('declares claude capabilities', () => {
    expect(supportsModelChange('claude')).toBe(true);
    expect(supportsEffort('claude')).toBe(true);
    expect(supportsLiveSession('claude')).toBe(true);
    expect(hasCapability('claude', Capabilities.AskUserQuestion)).toBe(true);
  });

  it('declares codex capabilities (no AskUserQuestion, no LiveSession)', () => {
    expect(supportsModelChange('codex')).toBe(true);
    expect(supportsEffort('codex')).toBe(true);
    expect(supportsLiveSession('codex')).toBe(false);
    expect(hasCapability('codex', Capabilities.AskUserQuestion)).toBe(false);
  });

  it('returns pretty labels', () => {
    expect(getFlavorLabel('claude')).toBe('Claude');
    expect(getFlavorLabel('codex')).toBe('Codex');
    expect(getFlavorLabel('bogus')).toBe('Unknown');
  });

  it('exports all flavor names as a const array', () => {
    expect(Flavors).toContain('claude');
    expect(Flavors).toContain('codex');
  });
});

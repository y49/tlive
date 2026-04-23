// src/im/commands/handoff.ts
//
// `/handoff` — alias for `/handoff-to-me` for users who type shorter.
// The plan manifest (spec §8 + T7) keeps this as a separate file so both
// canonical name + shorthand can appear in autocomplete lists if desired.

import type { CommandDef } from '../command-parser.js';
import { handoffToMeCmd } from './handoff-to-me.js';

export const handoffCmd: CommandDef = {
  name: 'handoff',
  role: handoffToMeCmd.role,
  description: 'Alias: /handoff-to-me',
  run: handoffToMeCmd.run,
};

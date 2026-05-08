// src/im/picker/picker.ts
//
// Reusable picker — used by /model /mode /think /perm /budget. Renders an
// inline keyboard with one button per item; on click, callback router
// matches `<callbackPrefix>:` and dispatches the value back to the
// command's set handler.

import type { ReplyMarkup } from '../../platform/types.js';

export interface PickerItem<T extends string = string> {
  label: string;
  value: T;
  marker?: '✅';
  disabled?: boolean;
}

export interface PickerOpts<T extends string = string> {
  title: string;
  items: PickerItem<T>[];
  callbackPrefix: string;   // e.g. 'model:set'
}

export interface PickerCtx {
  reply: (text: string, opts?: { replyMarkup?: ReplyMarkup }) => Promise<unknown>;
}

export async function renderPicker<T extends string>(
  ctx: PickerCtx,
  opts: PickerOpts<T>,
): Promise<void> {
  const buttons = opts.items.map((it) => [{
    text: it.marker ? `${it.marker} ${it.label}` : it.label,
    callbackData: it.disabled ? undefined : `${opts.callbackPrefix}:${it.value}`,
  }]);
  const replyMarkup: ReplyMarkup = { type: 'inline_keyboard', buttons };
  await ctx.reply(opts.title, { replyMarkup });
}

export interface ParsedCallback {
  prefix: string;
  value: string;
}

/**
 * Parse `<a>:<b>:<value...>` into prefix=`<a>:<b>` and value=remainder.
 * Used by callback-router to dispatch picker callbacks. Returns null when
 * the data doesn't have at least two `:` separators (i.e., fewer than 3
 * segments) — a single-segment string or two-segment string without
 * a value does not satisfy the picker contract.
 */
export function parsePickerCallback(data: string): ParsedCallback | null {
  // Picker prefix is always 2 segments: `<command>:set`. Anything after
  // the second `:` is the value (which itself may contain `:`).
  const firstColon = data.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = data.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  return {
    prefix: data.slice(0, secondColon),
    value: data.slice(secondColon + 1),
  };
}

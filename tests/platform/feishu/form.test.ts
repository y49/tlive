import { describe, it, expect } from 'vitest';
import { buildFormCard } from '../../../src/platform/feishu/form.js';

describe('feishu/form', () => {
  it('emits a form element with submit + reset actions', () => {
    const card = buildFormCard('Auth', [
      { name: 'user', label: 'User', type: 'text', required: true },
    ], 'req-1');
    const form = card.elements[0] as { tag: string; name: string; elements: Array<{ tag: string; name?: string; actions?: Array<{ form_action_type?: string; value?: { callback_data: string } }> }> };
    expect(form.tag).toBe('form');
    expect(form.name).toBe('req-1');
    const input = form.elements[0]!;
    expect(input.tag).toBe('input');
    expect(input.name).toBe('user');
    const action = form.elements[form.elements.length - 1]!;
    const submit = action.actions?.[0];
    const reset = action.actions?.[1];
    expect(submit?.form_action_type).toBe('submit');
    expect(submit?.value?.callback_data).toBe('elic:submit:req-1');
    expect(reset?.form_action_type).toBe('reset');
    expect(reset?.value?.callback_data).toBe('elic:decline:req-1');
  });
});

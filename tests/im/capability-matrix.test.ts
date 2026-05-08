import { describe, it, expect } from 'vitest';
import { CAPABILITIES, capabilitiesOf } from '../../src/im/capability-matrix.js';

describe('CAPABILITIES matrix', () => {
  it('Telegram supports forceReply but not modal', () => {
    expect(CAPABILITIES.telegram.forceReplyInput).toBe(true);
    expect(CAPABILITIES.telegram.modalForm).toBe(false);
    expect(CAPABILITIES.telegram.maxTextLen).toBe(4096);
    expect(CAPABILITIES.telegram.callbackDataMaxBytes).toBe(64);
  });

  it('Feishu supports native reactions and modal cards', () => {
    expect(CAPABILITIES.feishu.reactions).toBe(true);
    expect(CAPABILITIES.feishu.modalForm).toBe(true);
    expect(CAPABILITIES.feishu.pinMessage).toBe(true);
    expect(CAPABILITIES.feishu.autocompleteCommands).toBe(false);
  });

  it('capabilitiesOf returns the same object reference', () => {
    expect(capabilitiesOf('telegram')).toBe(CAPABILITIES.telegram);
    expect(capabilitiesOf('feishu')).toBe(CAPABILITIES.feishu);
  });
});

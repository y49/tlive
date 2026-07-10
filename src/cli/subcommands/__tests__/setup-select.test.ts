import { describe, it, expect } from 'vitest';
import { resolveVendorSelection } from '../setup';

const BOTH = { claude: true, codex: true };
describe('resolveVendorSelection', () => {
  it("回车/3/非法 → detected 原样", () => {
    for (const a of ['', '3', 'x']) expect(resolveVendorSelection(BOTH, a)).toEqual(BOTH);
  });
  it("'1' → 仅 claude", () => {
    expect(resolveVendorSelection(BOTH, '1')).toEqual({ claude: true, codex: false });
  });
  it("'2' → 仅 codex", () => {
    expect(resolveVendorSelection(BOTH, '2')).toEqual({ claude: false, codex: true });
  });
  it("选了未检测到的 → 不凭空开启", () => {
    expect(resolveVendorSelection({ claude: true, codex: false }, '2')).toEqual({ claude: false, codex: false });
  });
});

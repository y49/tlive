import { describe, it, expect } from 'vitest';
import { buildAskRequest, decideAskMode, type SdkAskUserQuestionInput } from '../../../src/im/ask/ask-hook-input.js';

describe('buildAskRequest — 透传 SDK 真值', () => {
  const sdk: SdkAskUserQuestionInput = {
    questions: [{
      question: '选择模块',
      header: '功能模块',
      options: [
        { label: '认证', description: 'JWT' },
        { label: '看板', description: '可视化' },
      ],
      multiSelect: true,
    }],
  };

  it('multiSelect=true allowCustom=false 时 mode=multi', () => {
    const req = buildAskRequest(sdk, 'r1', () => {});
    expect(req.id).toBe('r1');
    expect(req.prompt).toBe('选择模块');
    expect(req.header).toBe('功能模块');
    expect(req.options).toEqual([
      { label: '认证', description: 'JWT', preview: undefined },
      { label: '看板', description: '可视化', preview: undefined },
    ]);
    expect(req.multiSelect).toBe(true);
    expect(req.allowCustom).toBe(false);
  });

  it('multiSelect 缺失时默认 false,allowCustom 同样', () => {
    const noOptions: SdkAskUserQuestionInput = {
      questions: [{
        question: 'q', options: [{ label: 'a' }, { label: 'b' }],
      }],
    };
    const req = buildAskRequest(noOptions, 'r2', () => {});
    expect(req.multiSelect).toBe(false);
    expect(req.allowCustom).toBe(false);
  });
});

describe('decideAskMode', () => {
  it.each([
    [true, false, 'multi'],
    [true, true, 'multi'],
    [false, false, 'single'],
    [false, true, 'custom-input'],
  ])('multiSelect=%s allowCustom=%s → %s', (m, c, expected) => {
    expect(decideAskMode(m, c)).toBe(expected);
  });
});

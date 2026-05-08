// tests/e2e/commands/find.test.ts
//
// e2e tests for the /find command.
//
// Covers:
//   - /find <keyword> searches workspace history (discovery + search modules)
//   - /find with no arg shows usage hint in Chinese
//
// Uses setupBootstrap() so real command dispatch is exercised, including
// role gating. Relies on discoverSessions + searchSessions for the actual
// search logic (tested in unit tests); this e2e just verifies the command
// integrates correctly.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/find — workspace history search', () => {
  it('text /find <keyword> searches workspace history and returns result or "no matches"', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test-ws', workdir: '/tmp/tlive-e2e-find-1',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/find typescript', messageId: 'm1',
    });

    // Either results list or "no matches" — both valid outcomes.
    // The reply should not be empty.
    expect(env.replies.length).toBeGreaterThan(0);
    const reply = env.replies.join('\n');
    // Should contain either a success indicator, a match snippet, or the "no matches" msg.
    expect(reply).toMatch(/🔍|未找到|匹配/i);
  });

  it('text /find with no arg shows usage hint in Chinese', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test-ws', workdir: '/tmp/tlive-e2e-find-2',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/find', messageId: 'm2',
    });

    // Should show usage hint (contains Chinese keywords).
    expect(env.replies.length).toBeGreaterThan(0);
    const reply = env.replies.join('\n');
    expect(reply).toMatch(/用法|关键词|例|搜索/i);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRouter } from '../../src/im/sessionRouter.js';

describe('SessionRouter', () => {
  let router: SessionRouter;
  beforeEach(() => {
    router = new SessionRouter();
  });

  it('routes callback with explicit sessionId', () => {
    const r = router.route({ chatId: 'c1', isGroup: false, callbackSessionId: 'sid-explicit' });
    expect(r).toEqual({ kind: 'sdk_session', sessionId: 'sid-explicit' });
  });

  it('routes group message to bound session', () => {
    router.bindGroup('group-1', 'sid-g', '/proj');
    const r = router.route({ chatId: 'group-1', isGroup: true });
    expect(r).toEqual({ kind: 'sdk_session', sessionId: 'sid-g', workdir: '/proj' });
  });

  it('routes group message to new_session if unbound', () => {
    expect(router.route({ chatId: 'group-2', isGroup: true }).kind).toBe('new_session');
  });

  it('routes reply to terminal notification as takeover', () => {
    router.registerTerminalNotification('msg-42', 'sid-term', '/proj');
    const r = router.route({ chatId: 'c1', isGroup: false, replyToMessageId: 'msg-42' });
    expect(r).toEqual({ kind: 'terminal_takeover', sessionId: 'sid-term', workdir: '/proj' });
  });

  it('routes private text to existing private session', () => {
    router.bindPrivate('c1', 'sid-priv', '/home/proj');
    const r = router.route({ chatId: 'c1', isGroup: false });
    expect(r).toEqual({ kind: 'sdk_session', sessionId: 'sid-priv', workdir: '/home/proj' });
  });

  it('routes private text to new_session with remembered workdir', () => {
    router.bindPrivate('c1', 'sid-old', '/remembered');
    router.unbindPrivate('c1');
    const r = router.route({ chatId: 'c1', isGroup: false });
    expect(r).toEqual({ kind: 'new_session', workdir: '/remembered' });
  });

  it('routes private text to new_session without workdir if never seen', () => {
    const r = router.route({ chatId: 'new-user', isGroup: false });
    expect(r).toEqual({ kind: 'new_session', workdir: undefined });
  });
});

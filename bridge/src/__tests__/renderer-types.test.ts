import { describe, it, expectTypeOf } from 'vitest';
import type {
  NotificationEvent, ProgressSnapshot, CommandResponseData,
  TelegramOutbound, DiscordOutbound, FeishuOutbound, RenderedMessage,
  NotificationRenderer,
} from '../renderers/types.js';

describe('renderer types', () => {
  it('NotificationEvent is a discriminated union on kind', () => {
    const event: NotificationEvent = { kind: 'error', message: 'fail' };
    expectTypeOf(event).toMatchTypeOf<NotificationEvent>();
  });

  it('RenderedMessage is a union of platform types', () => {
    const t: TelegramOutbound = { html: '<b>hi</b>' };
    const d: DiscordOutbound = { embed: { title: 'hi' } };
    const f: FeishuOutbound = { card: '{}' };
    expectTypeOf(t).toMatchTypeOf<RenderedMessage>();
    expectTypeOf(d).toMatchTypeOf<RenderedMessage>();
    expectTypeOf(f).toMatchTypeOf<RenderedMessage>();
  });

  it('NotificationRenderer is generic over RenderedMessage', () => {
    type TR = NotificationRenderer<TelegramOutbound>;
    expectTypeOf<TR['channelType']>().toEqualTypeOf<'telegram' | 'discord' | 'feishu'>();
  });
});

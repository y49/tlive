import { getBridgeContext } from '../context.js';
import type { ChannelBinding } from '../store/interface.js';

export class ChannelRouter {
  private async ensureSession(sessionId: string, createdAt: string): Promise<void> {
    const { store, defaultWorkdir } = getBridgeContext();
    const session = await store.getSession(sessionId);
    if (session) {
      console.log(`[tlive:router] Session already exists: sessionId=${sessionId} workingDirectory=${JSON.stringify(session.workingDirectory)}`);
      return;
    }

    await store.saveSession({
      id: sessionId,
      workingDirectory: defaultWorkdir,
      createdAt,
    });
    console.log(`[tlive:router] Seeded missing session: sessionId=${sessionId} status=missing defaultWorkdir=${JSON.stringify(defaultWorkdir)}`);
  }

  async resolve(channelType: string, chatId: string): Promise<ChannelBinding> {
    const { store } = getBridgeContext();

    let binding = await store.getBinding(channelType, chatId);
    if (binding) {
      console.log(`[tlive:router] Reusing binding: channelType=${channelType} chatId=${chatId} sessionId=${binding.sessionId} createdAt=${binding.createdAt}`);
      await this.ensureSession(binding.sessionId, binding.createdAt);
      return binding;
    }

    // Auto-create binding for first message
    binding = {
      channelType,
      chatId,
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    await store.saveBinding(binding);
    console.log(`[tlive:router] Auto-created binding: channelType=${channelType} chatId=${chatId} sessionId=${binding.sessionId} createdAt=${binding.createdAt}`);
    await this.ensureSession(binding.sessionId, binding.createdAt);
    return binding;
  }

  async rebind(channelType: string, chatId: string, sessionId: string): Promise<ChannelBinding> {
    const { store } = getBridgeContext();
    const binding: ChannelBinding = {
      channelType,
      chatId,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    await store.saveBinding(binding);
    console.log(`[tlive:router] Rebound chat: channelType=${channelType} chatId=${chatId} sessionId=${binding.sessionId} createdAt=${binding.createdAt}`);
    await this.ensureSession(binding.sessionId, binding.createdAt);
    return binding;
  }
}

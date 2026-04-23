// src/platform/feishu/topic.ts
//
// Topic-per-session helper. Feishu groups support topics as of 2024; the
// `im/v1/threads` endpoint creates one. Typed loosely because the node SDK
// generates Chinese-doc method chains.

export interface StartFeishuTopicInput {
  chatId: string;
  topicName: string;
  /** Any opaque Client instance with im.chat.thread.create (loosely typed). */
  client: unknown;
}

export async function startFeishuTopic(input: StartFeishuTopicInput): Promise<string> {
  const client = input.client as {
    im: { v1: { chat: { thread: { create?: (args: unknown) => Promise<{ data?: { thread_id?: string } }> } } } };
  };
  const fn = client?.im?.v1?.chat?.thread?.create;
  if (!fn) throw new Error('Feishu SDK: im.v1.chat.thread.create unavailable');
  const res = await fn({
    data: {
      chat_id: input.chatId,
      name: input.topicName.slice(0, 100),
    },
  });
  return res.data?.thread_id ?? '';
}

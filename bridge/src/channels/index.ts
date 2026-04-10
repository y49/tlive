// Self-registration imports — uncomment as adapters are created
import './telegram.js';   // Task 23
import './discord.js';    // Task 24
import './feishu.js';     // Task 25

export { BaseChannelAdapter, createAdapter, registerAdapterFactory, getRegisteredTypes } from './base.js';
export type { ChannelType, InboundMessage, SendResult, Button, FileAttachment } from './types.js';

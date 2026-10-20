import { createStorageAtom, StorageKey } from '@/lib/local-storage';

import type { Model } from './settings';

export interface MessageStatus {
  isPending: boolean;
  isThinking: boolean;
  isStreaming: boolean;
  isAborted: boolean;
}

export interface UIMessage extends Partial<MessageStatus> {
  role: string;
  content: string;
  createAt: number;
  updateAt?: number;
  thinkingContent?: string;
  thinkingDuration?: number;
  cost?: {
    time: number;
    tokens: number;
  };
}

export interface Session {
  messages: UIMessage[];
  model?: Model;
  think?: boolean;
}

export const sessions = createStorageAtom(StorageKey.CHATS_HISTORY, { current: 0, data: [{ messages: [] }] as Session[] });

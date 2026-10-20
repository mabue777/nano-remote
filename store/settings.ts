import { AIProviderEnum } from '@/lib/ai';
import { createStorageAtom, StorageKey } from '@/lib/local-storage';

export interface Model {
  name: string;
  canThink?: boolean;
  isCustom?: boolean;
}

export interface Endpoint {
  provider: AIProviderEnum;
  host: string;
  apiKey: string;
  isLastUsed: boolean;
}

export interface Settings {
  provider: AIProviderEnum;
  host: string;
  apiKey: string;
  defaultModel?: Model;
  hapticFeedback: boolean;
  tokensUsage: number;
  endpoints: Endpoint[];
  voiceLanguage: 'zh-CN' | 'en-US';
}

export const settings = createStorageAtom(StorageKey.SETTINGS, {
  provider: AIProviderEnum.OLLAMA,
  host: '',
  apiKey: '',
  hapticFeedback: true,
  tokensUsage: 0,
  endpoints: [],
  voiceLanguage: 'en-US'
} as Settings);

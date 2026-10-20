import { type AnthropicProvider, type AnthropicProviderOptions, createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider, type GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';
import { createOpenAI, type OpenAIProvider, type OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import { createOpenAICompatible, type OpenAICompatibleChatModelId, type OpenAICompatibleProviderOptions } from '@ai-sdk/openai-compatible';
import { createProviderRegistry, defaultSettingsMiddleware, generateText, type JSONValue, type LanguageModel, type ModelMessage, streamText, wrapLanguageModel } from 'ai';
import { fetch } from 'expo/fetch';
import { createOllama, type OllamaCompletionProviderOptions, type OllamaProvider } from 'ollama-ai-provider-v2';

export enum AIProviderEnum {
  OLLAMA = 'ollama',
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  CUSTOM = 'custom',
  OPENCLAW = 'openclaw'
}

type ExtractLiteralUnion<T> = T extends string ? (string extends T ? never : T) : never;

interface ProviderOptions {
  [AIProviderEnum.OLLAMA]: OllamaCompletionProviderOptions;
  [AIProviderEnum.ANTHROPIC]: AnthropicProviderOptions;
  [AIProviderEnum.OPENAI]: OpenAIResponsesProviderOptions;
  [AIProviderEnum.GOOGLE]: GoogleGenerativeAIProviderOptions;
  [AIProviderEnum.CUSTOM]: OpenAICompatibleProviderOptions;
  [AIProviderEnum.OPENCLAW]: OpenAICompatibleProviderOptions;
}

interface ProviderModels {
  [AIProviderEnum.OLLAMA]: ExtractLiteralUnion<Parameters<OllamaProvider['languageModel']>[0]>;
  [AIProviderEnum.ANTHROPIC]: ExtractLiteralUnion<Parameters<AnthropicProvider['languageModel']>[0]>;
  [AIProviderEnum.OPENAI]: ExtractLiteralUnion<Parameters<OpenAIProvider['chat']>[0]>;
  [AIProviderEnum.GOOGLE]: ExtractLiteralUnion<Parameters<GoogleGenerativeAIProvider['languageModel']>[0]>;
  [AIProviderEnum.CUSTOM]: OpenAICompatibleChatModelId;
  [AIProviderEnum.OPENCLAW]: OpenAICompatibleChatModelId;
}

export class AIRegistry {
  private registry;

  constructor(host: string, apiKey?: string) {
    const openai = createOpenAI({ fetch: fetch as typeof globalThis.fetch, baseURL: host ? `${host}/v1` : void 0, apiKey });

    this.registry = createProviderRegistry({
      [AIProviderEnum.OLLAMA]: createOllama({ fetch: fetch as typeof globalThis.fetch, baseURL: host ? `${host}/api` : void 0, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }),
      [AIProviderEnum.ANTHROPIC]: createAnthropic({ fetch: fetch as typeof globalThis.fetch, baseURL: host ? `${host}/v1` : void 0, apiKey }),
      [AIProviderEnum.OPENAI]: { ...openai, languageModel: modelId => openai.chat(modelId) },
      [AIProviderEnum.GOOGLE]: createGoogleGenerativeAI({ fetch: fetch as typeof globalThis.fetch, baseURL: host ? `${host}/v1beta` : void 0, apiKey }),
      [AIProviderEnum.CUSTOM]: createOpenAICompatible({ fetch: fetch as typeof globalThis.fetch, name: 'provider-name', baseURL: host, apiKey }),
      [AIProviderEnum.OPENCLAW]: createOpenAICompatible({ fetch: fetch as typeof globalThis.fetch, name: 'openclaw', baseURL: host, apiKey, headers: { 'Content-Type': 'text/event-stream', 'x-openclaw-session-key': 'agent:main:main' } })
    });
  }

  model<const PROVIDER_ID extends AIProviderEnum>(id: PROVIDER_ID extends string ? `${PROVIDER_ID}:${ProviderModels[PROVIDER_ID]}` : never, providerOptions?: ProviderOptions): LanguageModel;
  // eslint-disable-next-line @typescript-eslint/unified-signatures
  model<const PROVIDER_ID extends AIProviderEnum>(id: PROVIDER_ID extends string ? `${PROVIDER_ID}:${string}` : never, providerOptions?: ProviderOptions): LanguageModel;
  model<const PROVIDER_ID extends AIProviderEnum>(id: `${PROVIDER_ID}:${string}`, providerOptions?: ProviderOptions) {
    return wrapLanguageModel({
      model: this.registry.languageModel(id satisfies string),
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: providerOptions as Record<PROVIDER_ID, Record<string, JSONValue>> }
      })
    });
  }
}

interface ChatRequest {
  messages: ModelMessage[];
  model: LanguageModel;
}

type WithAbort<T> = [T, AbortController['abort']];

export function chat(request: ChatRequest & { stream: true }): WithAbort<ReturnType<typeof streamText>['fullStream']>;
export function chat(request: ChatRequest & { stream?: false }): Promise<WithAbort<string>>;
export function chat(request: ChatRequest & { stream?: boolean }) {
  const { stream = false, messages, model } = request;
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  const settings = { messages, model, abortSignal: abortController.signal };

  if (stream) {
    const { fullStream } = streamText(settings);
    return [fullStream, abort];
  }

  return generateText(settings).then(({ text }) => [text, abort]);
}

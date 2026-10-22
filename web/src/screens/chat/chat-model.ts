// The chat page, /c/:chatId (local-chat.md ruling R4): the messages with their reasoning blocks and usage
// lines, the streamed reply, the composer with Stop, copy on long-press, the model picker (the provider
// store's cached models, with a refresh per provider) and the thinking switch where the model reasons.
// Sending goes through the chat engine (ADR 0006 picks the route); a host-routed provider without the Mac
// ends in the engine's one sentence. All state lives in the ChatStore and ProviderStore; this model reads
// them on every change and adds only what the page itself holds.
import type { ChatEngine } from '../../chat/engine/chat';
import { chatMessage, HOST_UNAVAILABLE_MESSAGE } from '../../chat/engine/errors';
import type { HostLink } from '../../chat/engine/host';
import { sendMessage, type Chat, type ChatMessage, type ChatStore } from '../../chat/engine/history';
import type { ChatErrorReason, ChatUsage } from '../../chat/engine/types';
import { probeModels, type FetchLike } from '../../chat/providers/probe';
import type { ProviderStore } from '../../chat/providers/store';
import type { ModelInfo, ProviderRecord } from '../../chat/providers/types';
import { routeFor } from '../../chat/providers/url';
import { Model } from '../model';
import { parseMarkdown, type Block } from './markdown';
import { REMOVED_PROVIDER } from './chats-list-model';

/** How long the "Copied" notice stays. */
export const COPIED_MS = 1500;

export const MISSING_CHAT = 'This chat is not on this phone.';
export const MISSING_PROVIDER = "This chat's provider was removed. Pick another model.";
export const NO_MODEL = 'Pick a model to start.';

export interface Clipboard {
  writeText(text: string): Promise<void>;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ChatModelOptions {
  chatId: string;
  chats: ChatStore;
  providers: ProviderStore;
  engine: ChatEngine;
  /** The stream client to the paired Mac, or null; used to refresh a host-routed provider's models. */
  host?: () => HostLink | null;
  /** The browser's fetch, for refreshing a direct provider's models. */
  fetch?: FetchLike;
  clipboard?: Clipboard | null;
  timers?: Timers;
}

export interface ReasoningRow {
  text: string;
  expanded: boolean;
}

export interface MessageRow {
  index: number;
  role: 'user' | 'assistant';
  text: string;
  /** Assistant text as markdown blocks; user text stays plain. */
  blocks: Block[];
  reasoning?: ReasoningRow;
  streaming: boolean;
  /** "Stopped" for a reply cut short by Stop; empty otherwise. */
  label: string;
  /** The engine's one sentence, for a failed reply. */
  error?: string;
  /** "12 in · 40 out tokens", when the provider reported counts. */
  usage?: string;
}

export interface PickerModel {
  id: string;
  label: string;
  selected: boolean;
}

export interface PickerGroup {
  providerId: string;
  name: string;
  /** ADR 0006 in one line: "direct" or "via your Mac". */
  route: string;
  models: PickerModel[];
  refreshing: boolean;
  /** One sentence when the last refresh failed. */
  error?: string;
}

/** "12 in · 40 out tokens"; undefined when the provider reported no counts. */
export function usageLine(usage: ChatUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  return parts.length === 0 ? undefined : `${parts.join(' · ')} tokens`;
}

export function routeLabel(baseURL: string): string {
  return routeFor(baseURL) === 'host' ? 'via your Mac' : 'direct';
}

export class ChatModel extends Model {
  readonly chatId: string;
  private readonly chats: ChatStore;
  private readonly providers: ProviderStore;
  private readonly engine: ChatEngine;
  private readonly host: () => HostLink | null;
  private readonly fetch: FetchLike | undefined;
  private readonly clipboard: Clipboard | null;
  private readonly timers: Timers;
  private readonly unsubscribe: (() => void)[];
  private controller: AbortController | undefined;
  private draftValue = '';
  private thinkingValue = true;
  private pickerOpenValue = false;
  private readonly expanded = new Map<number, boolean>();
  private readonly refreshing = new Set<string>();
  private readonly refreshErrors = new Map<string, string>();
  private copiedValue: number | undefined;
  private copyErrorValue: string | undefined;
  private copiedTimer: unknown;
  private scrollRequestValue = 0;
  private disposed = false;

  constructor(options: ChatModelOptions) {
    super();
    this.chatId = options.chatId;
    this.chats = options.chats;
    this.providers = options.providers;
    this.engine = options.engine;
    this.host = options.host ?? (() => null);
    this.fetch = options.fetch;
    this.clipboard = options.clipboard ?? null;
    this.timers = options.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as number) };
    this.unsubscribe = [this.chats.subscribe(() => this.changed()), this.providers.subscribe(() => this.changed())];
  }

  /** Stops a running reply (its partial text stays, marked stopped) and lets go of the stores. */
  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.timers.clear(this.copiedTimer);
    for (const off of this.unsubscribe) off();
  }

  private get chat(): Chat | undefined {
    return this.chats.get(this.chatId);
  }

  private get provider(): ProviderRecord | undefined {
    const chat = this.chat;
    return chat === undefined ? undefined : this.providers.get(chat.providerId);
  }

  get found(): boolean {
    return this.chat !== undefined;
  }

  get title(): string {
    return this.chat?.title ?? 'Chat';
  }

  get providerName(): string {
    return this.provider?.name ?? REMOVED_PROVIDER;
  }

  get routeLabel(): string | undefined {
    const provider = this.provider;
    return provider === undefined ? undefined : routeLabel(provider.baseURL);
  }

  get modelId(): string {
    return this.chat?.model ?? '';
  }

  /** The header's model button: the display name, the id, or "Pick a model". */
  get modelLabel(): string {
    const id = this.modelId;
    if (id === '') return 'Pick a model';
    return this.currentModel()?.displayName ?? id;
  }

  /** A line above the composer when the chat cannot send (no chat, no provider, no model). */
  get notice(): string | undefined {
    if (!this.found) return MISSING_CHAT;
    if (this.provider === undefined) return MISSING_PROVIDER;
    if (this.modelId === '') return NO_MODEL;
    return undefined;
  }

  get rows(): MessageRow[] {
    const messages = this.chat?.messages ?? [];
    return messages.map((m, index) => this.row(m, index));
  }

  get streaming(): boolean {
    return this.controller !== undefined;
  }

  get draft(): string {
    return this.draftValue;
  }

  setDraft(text: string): void {
    this.draftValue = text;
    this.changed();
  }

  get canSend(): boolean {
    return !this.streaming && this.notice === undefined && this.draftValue.trim() !== '';
  }

  /** Bumped by a send so the view scrolls to the bottom even when the user had scrolled up. */
  get scrollRequest(): number {
    return this.scrollRequestValue;
  }

  /** Sends the draft and streams the reply; resolves when the reply has ended. */
  async send(): Promise<void> {
    const provider = this.provider;
    if (!this.canSend || provider === undefined) return;
    const text = this.draftValue.trim();
    this.draftValue = '';
    const controller = new AbortController();
    this.controller = controller;
    this.scrollRequestValue += 1;
    const options = this.thinkingAvailable ? { thinking: this.thinkingValue } : {};
    try {
      await sendMessage(this.engine, this.chats, this.chatId, provider, text, options, controller.signal);
    } finally {
      this.controller = undefined;
      if (!this.disposed) this.changed();
    }
  }

  /** Stop while streaming: cancels the request; the text streamed so far stays. */
  stop(): void {
    this.controller?.abort();
  }

  /** The thinking switch shows only when the current model's capabilities say it reasons. */
  get thinkingAvailable(): boolean {
    return this.currentModel()?.capabilities.reasoning === true;
  }

  get thinking(): boolean {
    return this.thinkingValue;
  }

  toggleThinking(): void {
    this.thinkingValue = !this.thinkingValue;
    this.changed();
  }

  /** A reply's reasoning shows while it is the only thing streaming, then folds; a tap overrides that. */
  toggleReasoning(index: number): void {
    const row = this.rows[index];
    if (row?.reasoning === undefined) return;
    this.expanded.set(index, !row.reasoning.expanded);
    this.changed();
  }

  /** Copy on long-press. */
  async copy(index: number): Promise<void> {
    const message = this.chat?.messages[index];
    if (message === undefined) return;
    this.timers.clear(this.copiedTimer);
    try {
      if (this.clipboard === null) throw new Error('no clipboard');
      await this.clipboard.writeText(message.text);
      this.copiedValue = index;
      this.copyErrorValue = undefined;
    } catch {
      this.copiedValue = undefined;
      this.copyErrorValue = 'This browser did not allow copying. Select the text instead.';
    }
    this.copiedTimer = this.timers.set(() => {
      this.copiedValue = undefined;
      this.copyErrorValue = undefined;
      this.changed();
    }, COPIED_MS);
    this.changed();
  }

  /** The index of the message just copied, while the "Copied" notice shows. */
  get copied(): number | undefined {
    return this.copiedValue;
  }

  get copyError(): string | undefined {
    return this.copyErrorValue;
  }

  get pickerOpen(): boolean {
    return this.pickerOpenValue;
  }

  openPicker(): void {
    this.pickerOpenValue = true;
    this.changed();
  }

  closePicker(): void {
    this.pickerOpenValue = false;
    this.changed();
  }

  /** Every provider with its cached models; the current provider first. */
  get pickerGroups(): PickerGroup[] {
    const chat = this.chat;
    const records = this.providers.list();
    const current = records.findIndex((r) => r.id === chat?.providerId);
    if (current > 0) records.unshift(...records.splice(current, 1));
    return records.map((record) => {
      const group: PickerGroup = {
        providerId: record.id,
        name: record.name,
        route: routeLabel(record.baseURL),
        models: this.providers.visibleModels(record.id).map((m) => ({
          id: m.id,
          label: m.displayName,
          selected: chat?.providerId === record.id && chat.model === m.id,
        })),
        refreshing: this.refreshing.has(record.id),
      };
      const error = this.refreshErrors.get(record.id);
      if (error !== undefined) group.error = error;
      return group;
    });
  }

  /** Picks a model (and with it its provider) for this chat's next replies. */
  selectModel(providerId: string, modelId: string): void {
    if (!this.found || this.providers.get(providerId) === undefined) return;
    this.chats.setModel(this.chatId, providerId, modelId);
    this.pickerOpenValue = false;
    this.changed();
  }

  /** Fetches a provider's model list again and caches it; a failure is one sentence on its group. */
  async refreshModels(providerId: string): Promise<void> {
    const record = this.providers.get(providerId);
    if (record === undefined || this.refreshing.has(providerId)) return;
    this.refreshing.add(providerId);
    this.refreshErrors.delete(providerId);
    this.changed();
    const result = routeFor(record.baseURL) === 'host' ? await this.hostModels(record) : await this.directModels(record);
    this.refreshing.delete(providerId);
    if (typeof result === 'string') this.refreshErrors.set(providerId, result);
    else if (this.providers.get(providerId) !== undefined) this.providers.setModels(providerId, result);
    if (!this.disposed) this.changed();
  }

  private async directModels(record: ProviderRecord): Promise<ModelInfo[] | string> {
    if (this.fetch === undefined) return `${record.name} cannot be asked for its models from here.`;
    const result = await probeModels(
      { name: record.name, baseURL: record.baseURL, kind: record.kind, apiKey: this.providers.getKey(record.id) },
      { fetch: this.fetch },
    );
    return result.ok ? result.models : result.message;
  }

  /** protocol section 15, `provider/models`: the host probes the provider and answers its list. */
  private async hostModels(record: ProviderRecord): Promise<ModelInfo[] | string> {
    const host = this.host();
    if (host === null || host.state !== 'ready') return HOST_UNAVAILABLE_MESSAGE;
    const params: Record<string, unknown> = { baseURL: record.baseURL };
    if (record.kind !== 'gemini') params.kind = record.kind;
    try {
      const reply = await host.request<{ models?: { id?: unknown; displayName?: unknown }[] }>('provider/models', params);
      const models: ModelInfo[] = [];
      for (const m of reply.models ?? []) {
        if (typeof m.id !== 'string' || m.id === '') continue;
        const displayName = typeof m.displayName === 'string' && m.displayName !== '' ? m.displayName : m.id;
        models.push({ id: m.id, displayName, capabilities: {}, source: 'unknown' });
      }
      return models.length === 0 ? `${record.name} answered but lists no models. Check the server.` : models;
    } catch (error) {
      const e = error as { code?: unknown; data?: { reason?: unknown } };
      if (e.code === 'connection_lost' || e.code === 'client_closed' || e.code === 'timeout') return HOST_UNAVAILABLE_MESSAGE;
      if (e.code === 'provider_unavailable' && typeof e.data?.reason === 'string') {
        return chatMessage(record.name, e.data.reason as ChatErrorReason);
      }
      return `${record.name} could not list its models. Try again.`;
    }
  }

  private currentModel(): ModelInfo | undefined {
    const chat = this.chat;
    if (chat === undefined || this.provider === undefined) return undefined;
    return this.providers.visibleModels(chat.providerId).find((m) => m.id === chat.model);
  }

  private row(m: ChatMessage, index: number): MessageRow {
    const streaming = m.status === 'streaming';
    const row: MessageRow = {
      index,
      role: m.role,
      text: m.text,
      blocks: m.role === 'assistant' ? parseMarkdown(m.text) : [],
      streaming,
      label: m.status === 'stopped' ? 'Stopped' : '',
    };
    if (m.reasoning !== undefined && m.reasoning !== '') {
      row.reasoning = { text: m.reasoning, expanded: this.expanded.get(index) ?? (streaming && m.text === '') };
    }
    if (m.status === 'failed' && m.error !== undefined) row.error = m.error;
    const usage = usageLine(m.usage);
    if (usage !== undefined) row.usage = usage;
    return row;
  }
}

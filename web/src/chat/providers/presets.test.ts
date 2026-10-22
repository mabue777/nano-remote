import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CUSTOM_PRESET, detect, kindForHost, PRESETS, presetForKey } from './presets';
import { normalizeBaseURL, routeFor } from './url';

const named = PRESETS.filter((p) => p.baseURL !== '');

describe('providers.json', () => {
  it('lists the section 2 presets plus Custom URL, each with every field', () => {
    expect(PRESETS.map((p) => p.name)).toEqual([
      'OpenAI',
      'Anthropic',
      'Google Gemini',
      'OpenRouter',
      'Groq',
      'Mistral',
      'DeepSeek',
      'Together',
      'Fireworks',
      'xAI',
      'Moonshot (Kimi)',
      'Z.AI',
      'Ollama (local)',
      'Ollama Cloud',
      'LM Studio (local)',
      'llama.cpp (local)',
      'vLLM (local)',
      'Custom URL',
    ]);
    for (const preset of PRESETS) {
      expect(Object.keys(preset).sort()).toEqual(
        ['baseURL', 'docsURL', 'keyHelpURL', 'keyPrefixes', 'kind', 'name', 'notes'].sort(),
      );
      expect(preset.notes).not.toBe('');
    }
    expect(CUSTOM_PRESET.name).toBe('Custom URL');
    expect(PRESETS.filter((p) => p.baseURL === '')).toHaveLength(1);
  });

  it('has a sibling README that dates the verification', () => {
    const readme = readFileSync(new URL('../presets/README.md', import.meta.url), 'utf8');
    expect(readme).toMatch(/Verified on \d{4}-\d{2}-\d{2}/);
    for (const preset of named) expect(readme).toContain(preset.baseURL);
  });

  it('has no key prefix shared by two presets', () => {
    const all = PRESETS.flatMap((p) => p.keyPrefixes);
    expect(new Set(all).size).toBe(all.length);
  });

  describe.each(named.map((p) => [p.name, p] as const))('%s', (_name, preset) => {
    it('has a base URL that normalizes to itself', () => {
      expect(normalizeBaseURL(preset.baseURL)).toBe(preset.baseURL);
    });

    it('derives its kind from the host', () => {
      expect(kindForHost(preset.baseURL)).toBe(preset.kind);
    });

    it('routes https cloud presets direct and local presets through the host', () => {
      expect(routeFor(preset.baseURL)).toBe(preset.baseURL.startsWith('https://') ? 'direct' : 'host');
    });

    it('is selected by each of its key prefixes', () => {
      for (const prefix of preset.keyPrefixes) expect(presetForKey(`${prefix}abc123`)).toBe(preset);
    });
  });
});

describe('kindForHost', () => {
  it.each([
    ['https://api.anthropic.com/v1', 'anthropic'],
    ['https://eu.api.anthropic.com', 'anthropic'],
    ['https://api.anthropic.com.evil.example', 'openai-compatible'],
    ['https://notapi.anthropic.com', 'openai-compatible'],
    ['https://generativelanguage.googleapis.com', 'gemini'],
    ['https://www.ollama.com', 'ollama'],
    ['https://myollama.com', 'openai-compatible'],
    ['http://localhost:11434', 'ollama'],
    ['http://mac.tail1234.ts.net:11434', 'ollama'],
    ['http://localhost:1234/v1', 'openai-compatible'],
    ['https://api.openai.com/v1', 'openai-compatible'],
    ['https://llm.example.com/v1', 'openai-compatible'],
  ])('%s -> %s', (url, kind) => {
    expect(kindForHost(url)).toBe(kind);
  });

  it('throws for something that is not a base URL', () => {
    expect(() => kindForHost('')).toThrow();
  });
});

describe('detect', () => {
  it('is empty for blank input', () => {
    expect(detect('   ')).toEqual({ type: 'empty' });
  });

  it.each([
    ['sk-ant-api03-xyz', 'Anthropic'],
    ['sk-or-v1-xyz', 'OpenRouter'],
    ['sk-proj-xyz', 'OpenAI'],
    ['gsk_xyz', 'Groq'],
    ['xai-xyz', 'xAI'],
    ['AIzaSyXyz', 'Google Gemini'],
  ])('a key %s selects %s and pre-fills its URL', (key, name) => {
    const result = detect(`  ${key} `);
    expect(result.type).toBe('key');
    if (result.type !== 'key') return;
    expect(result.preset.name).toBe(name);
    expect(result.apiKey).toBe(key);
    expect(result.baseURL).toBe(result.preset.baseURL);
    expect(result.kind).toBe(result.preset.kind);
    expect(result.route).toBe('direct');
  });

  it('a key without a known prefix asks for the preset', () => {
    expect(detect('sk-1234567890abcdef')).toEqual({ type: 'unknown-key', apiKey: 'sk-1234567890abcdef' });
    expect(detect('abc')).toEqual({ type: 'unknown-key', apiKey: 'abc' });
  });

  it.each([
    ['https://llm.example.com/v1/', 'https://llm.example.com/v1', 'openai-compatible', 'direct'],
    ['http://192.168.1.20:11434', 'http://192.168.1.20:11434', 'ollama', 'host'],
    ['localhost:1234/v1', 'http://localhost:1234/v1', 'openai-compatible', 'host'],
    ['LOCALHOST', 'http://localhost', 'openai-compatible', 'host'],
    ['api.anthropic.com', 'https://api.anthropic.com', 'anthropic', 'direct'],
    ['mac.tail1234.ts.net:11434', 'http://mac.tail1234.ts.net:11434', 'ollama', 'host'],
  ])('a URL %s selects Custom and derives the kind', (input, baseURL, kind, route) => {
    expect(detect(input)).toEqual({ type: 'url', preset: CUSTOM_PRESET, baseURL, kind, route });
  });

  it('a malformed URL is treated as an unknown key, not a crash', () => {
    expect(detect('ftp://files.example.com')).toEqual({ type: 'unknown-key', apiKey: 'ftp://files.example.com' });
  });
});

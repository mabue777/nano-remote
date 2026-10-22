import { describe, expect, it } from 'vitest';

import { hostLabel, isPrivateHost, normalizeBaseURL, parseBase, routeFor } from './url';

describe('normalizeBaseURL', () => {
  it.each([
    ['https://API.OpenAI.com/v1/', 'https://api.openai.com/v1'],
    ['HTTPS://api.openai.com:443/v1//', 'https://api.openai.com/v1'],
    ['http://localhost:80/', 'http://localhost'],
    ['  https://openrouter.ai/api/v1?x=1#frag  ', 'https://openrouter.ai/api/v1'],
    ['http://192.168.1.5:11434', 'http://192.168.1.5:11434'],
    ['https://example.com:8443/base', 'https://example.com:8443/base'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBaseURL(input)).toBe(expected);
  });

  it('adds http for private hosts and https for public ones when the scheme is missing', () => {
    expect(normalizeBaseURL('localhost:11434')).toBe('http://localhost:11434');
    expect(normalizeBaseURL('192.168.0.10:1234/v1')).toBe('http://192.168.0.10:1234/v1');
    expect(normalizeBaseURL('mac.tail1234.ts.net:11434')).toBe('http://mac.tail1234.ts.net:11434');
    expect(normalizeBaseURL('api.groq.com/openai/v1/')).toBe('https://api.groq.com/openai/v1');
  });

  it('gives equal identities for spellings of the same endpoint', () => {
    const a = normalizeBaseURL('https://api.mistral.ai/v1');
    expect(normalizeBaseURL('https://API.MISTRAL.AI:443/v1/')).toBe(a);
    expect(normalizeBaseURL('api.mistral.ai/v1')).toBe(a);
    expect(normalizeBaseURL('https://api.mistral.ai/v2')).not.toBe(a);
    expect(normalizeBaseURL('http://api.mistral.ai/v1')).not.toBe(a);
  });

  it.each(['', '   ', 'ftp://example.com', 'https://user:pw@example.com', 'not a url', 'http://', 'http://[zz]'])(
    'rejects %j',
    (input) => {
      expect(normalizeBaseURL(input)).toBeNull();
    },
  );
});

describe('routeFor (ADR 0006)', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://ollama.com',
    'https://8.8.8.8',
    'https://172.32.0.1',
    'https://100.128.0.1',
    'https://[2001:db8::1]',
  ])('%s goes direct', (url) => {
    expect(routeFor(url)).toBe('direct');
  });

  it.each([
    'http://api.example.com/v1',
    'http://localhost:11434',
    'https://localhost:8443',
    'https://127.0.0.1',
    'https://10.0.0.2',
    'https://172.16.0.1',
    'https://172.31.255.255',
    'https://192.168.1.1',
    'https://169.254.1.1',
    'https://0.0.0.0',
    'https://100.64.0.1',
    'https://100.127.255.255',
    'https://mac.local',
    'https://mac.tail1234.ts.net',
    'https://app.localhost',
    'https://mymac',
    'https://[::1]',
    'https://[fd12:3456::1]',
    'https://[fe80::1]',
    'https://[::ffff:192.168.0.1]',
  ])('%s goes through the host', (url) => {
    expect(routeFor(url)).toBe('host');
  });

  it('throws for something that is not a base URL', () => {
    expect(() => routeFor('ftp://x')).toThrow(/not a base URL/);
  });
});

describe('isPrivateHost', () => {
  it('treats a mapped public IPv4 and a trailing dot correctly', () => {
    expect(isPrivateHost('[::ffff:808:808]')).toBe(false);
    expect(isPrivateHost('mac.local.')).toBe(true);
    expect(isPrivateHost('999.1.1.1')).toBe(false);
    expect(isPrivateHost('[2001:db8::1]')).toBe(false);
  });
});

describe('hostLabel and parseBase', () => {
  it('shows host and port', () => {
    expect(hostLabel('http://mac.local:11434/v1')).toBe('mac.local:11434');
    expect(hostLabel('nonsense')).toBe('nonsense');
  });

  it('parses a normalized URL', () => {
    expect(parseBase('API.x.ai/v1').href).toBe('https://api.x.ai/v1');
  });
});

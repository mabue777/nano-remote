import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceStore } from '../devices/store.js';
import { Journal } from '../journal/journal.js';
import { ensurePrivateDir, ensurePrivateFile } from './private-files.js';

let dir: string;
const mode = (file: string) => statSync(file).mode & 0o777;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nano-files-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('private files', () => {
  it('security: the Journal and the device store are 0600, with their WAL files, in a new 0700 folder', () => {
    const file = path.join(dir, 'NanoHost', 'journal.sqlite');
    const journal = new Journal({ path: file });
    const devices = new DeviceStore({ path: file });
    try {
      devices.create({ displayName: 'Phone', platform: 'ios-web' });
      expect(mode(path.dirname(file))).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      for (const side of [`${file}-wal`, `${file}-shm`]) {
        expect(existsSync(side)).toBe(true);
        expect(mode(side)).toBe(0o600);
      }
    } finally {
      devices.close();
      journal.close();
    }
  });

  it('security: tightens an existing database file and leaves a folder the user chose alone', () => {
    const own = path.join(dir, 'Documents');
    mkdirSync(own, { mode: 0o755 });
    chmodSync(own, 0o755);
    const file = path.join(own, 'journal.sqlite');
    writeFileSync(file, '', { mode: 0o644 });
    chmodSync(file, 0o644);
    new Journal({ path: file }).close();
    expect(mode(file)).toBe(0o600);
    expect(mode(own)).toBe(0o755);
  });

  it('creates and tightens folders and files', () => {
    const folder = path.join(dir, 'a', 'b');
    mkdirSync(folder, { recursive: true, mode: 0o755 });
    ensurePrivateDir(folder);
    expect(mode(folder)).toBe(0o700);
    const file = path.join(dir, 'new', 'secret');
    ensurePrivateFile(file);
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
  });
});

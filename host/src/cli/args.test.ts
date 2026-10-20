import { describe, expect, it } from 'vitest';

import { parseArgs, UsageError } from './args.js';

describe('parseArgs', () => {
  it('parses every command', () => {
    expect(parseArgs(['start'])).toEqual({ name: 'start', insecureDev: false });
    expect(parseArgs(['start', '--config', '/tmp/c.json', '--insecure-dev'])).toEqual({
      name: 'start',
      config: '/tmp/c.json',
      insecureDev: true,
    });
    expect(parseArgs(['start', '--config=/tmp/c.json'])).toEqual({ name: 'start', config: '/tmp/c.json', insecureDev: false });
    expect(parseArgs(['status'])).toEqual({ name: 'status' });
    expect(parseArgs(['pair', '--config', 'c.json'])).toEqual({ name: 'pair', config: 'c.json' });
    expect(parseArgs(['devices'])).toEqual({ name: 'devices', action: 'list' });
    expect(parseArgs(['devices', 'list'])).toEqual({ name: 'devices', action: 'list' });
    expect(parseArgs(['devices', 'revoke', 'dev_1'])).toEqual({ name: 'devices', action: 'revoke', clientId: 'dev_1' });
    expect(parseArgs(['devices', 'rename', 'dev_1', 'Work iPhone'])).toEqual({
      name: 'devices',
      action: 'rename',
      clientId: 'dev_1',
      displayName: 'Work iPhone',
    });
    expect(parseArgs(['devices', 'rename', 'dev_1', 'Work', 'iPhone'])).toMatchObject({ displayName: 'Work iPhone' });
    expect(parseArgs(['cert'])).toEqual({ name: 'cert' });
    expect(parseArgs(['install'])).toEqual({ name: 'install' });
    expect(parseArgs(['uninstall'])).toEqual({ name: 'uninstall' });
    expect(parseArgs(['version'])).toEqual({ name: 'version' });
    expect(parseArgs(['--version'])).toEqual({ name: 'version' });
    expect(parseArgs(['help'])).toEqual({ name: 'help' });
    expect(parseArgs(['pair', '--help'])).toEqual({ name: 'help' });
  });

  it('accepts a name that starts with a dash after --', () => {
    expect(parseArgs(['devices', 'rename', 'dev_1', '--', '-phone-'])).toMatchObject({ displayName: '-phone-' });
  });

  it.each([
    [[], /no command/],
    [['frobnicate'], /unknown command/],
    [['start', '--verbose'], /unknown option --verbose/],
    [['status', '--insecure-dev'], /unknown option/],
    [['start', 'extra'], /expected no arguments/],
    [['start', '--config'], /--config needs a path/],
    [['start', '--config', 'a', '--config', 'b'], /twice/],
    [['uninstall', '--config', 'a'], /not accepted/],
    [['devices', 'revoke'], /expected <clientId>/],
    [['devices', 'revoke', 'a', 'b'], /expected <clientId>/],
    [['devices', 'rename', 'dev_1'], /expected <clientId> <name>/],
    [['devices', 'list', 'x'], /expected no arguments/],
    [['devices', 'nuke'], /unknown action/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

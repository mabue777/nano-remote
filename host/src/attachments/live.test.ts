// Live check of attachments (spec 8.1): a scripted client uploads a test image and a text file to a real
// host (a temporary config folder, a free port on 127.0.0.1, never the operator's running host), and one
// Codex session and one Pi session on this Mac each describe the image and read the file. Runs only with
// NANO_LIVE_ATTACHMENTS=1; never in the gate (it needs the operator's Codex and pi logins and spends tokens):
//
//   NANO_LIVE_ATTACHMENTS=1 pnpm -C host exec vitest run src/attachments/live.test.ts
//
// NANO_LIVE_ATTACHMENTS_PI_MODEL picks pi's model (default ollama/gemma4:cloud, which takes images).
// Every step is printed and appended to $NANO_LIVE_ATTACHMENTS_LOG (default $TMPDIR/nano-live-attachments.log).
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig, type HostConfig } from '../cli/config.js';
import { createLogger } from '../cli/log.js';
import { attachmentsDir, buildAgents, HostService } from '../cli/service.js';
import { rpc } from '../core/testing/harness.js';
import { TestClient } from '../stream/testing/client.js';

const LIVE = process.env.NANO_LIVE_ATTACHMENTS === '1';
const PI_MODEL = process.env.NANO_LIVE_ATTACHMENTS_PI_MODEL ?? 'ollama/gemma4:cloud';
const LOG = process.env.NANO_LIVE_ATTACHMENTS_LOG ?? path.join(tmpdir(), 'nano-live-attachments.log');
const TURN_MS = 300_000;

function step(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(LOG, `${stamped}\n`);
}

/** A PNG: left half red, right half blue, `width` x `height` (no image library needed). */
export function redBluePng(width = 256, height = 128): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = x < width / 2 ? [220, 20, 20] : [20, 40, 220];
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CODE_WORD = 'PERIWINKLE-42';
const IMAGE_PROMPT = 'Describe the attached image in one sentence. Name its two colors and say which is on the left.';
const FILE_PROMPT = 'What is the code word in the attached file? Answer with the code word only.';

describe.skipIf(!LIVE)('live: attachments reach Codex and Pi through the host', () => {
  let home: string;
  let service: HostService;
  let phone: TestClient;
  let token: string;
  let base: string;
  let config: HostConfig;
  let keepAlive: NodeJS.Timeout | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'nano-live-attach-')));
    config = {
      ...defaultConfig(home, 'host_live_attach'),
      listenAddresses: ['127.0.0.1'],
      port: 0,
      journalPath: path.join(home, 'journal.sqlite'),
      logFile: path.join(home, 'logs', 'host.log'),
      enabledAgents: ['codex', 'pi'],
    };
    const logger = createLogger({ file: config.logFile, stdout: { write: () => {} } });
    service = await HostService.start({
      config,
      configPath: path.join(home, 'config.json'),
      logger,
      insecureDev: true,
      agents: buildAgents(config, logger),
      publicDir: home,
      drainMs: 0,
      keepAwake: { supported: false },
    });
    base = `http://127.0.0.1:${service.server.port}`;
    const device = service.devices.create({ displayName: 'live script', platform: 'script', userAgent: 'live.test.ts' });
    token = device.token;
    phone = await TestClient.connect(`ws://127.0.0.1:${service.server.port}/v1/stream`, { token, clientId: device.device.clientId });
    const init = (await phone.handshake()) as { result: { agents: unknown[]; limits: unknown } };
    keepAlive = setInterval(() => phone.ping(), 30_000);
    step(`host on ${base}, config folder ${home}; limits ${JSON.stringify(init.result.limits)}`);
    for (const agent of init.result.agents) step(`agent ${JSON.stringify(agent)}`);
  }, 120_000);

  afterAll(async () => {
    clearInterval(keepAlive);
    phone?.close();
    await service?.shutdown('test');
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  async function upload(sessionId: string, name: string, type: string, body: Buffer): Promise<{ url: string; name: string; mediaType: string; size: number }> {
    const response = await fetch(`${base}/v1/blob?${new URLSearchParams({ sessionId, name })}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': type },
      body,
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as { url: string; name: string; mediaType: string; size: number };
    step(`uploaded ${name}: ${JSON.stringify(result)}`);
    return result;
  }

  /** Runs one turn, answers approvals (accepting only commands that read the attachments folder), returns the agent's text. */
  async function turn(sessionId: string, input: unknown[], label: string): Promise<string> {
    const before = phone.messages.length;
    const t0 = Date.now();
    const { turn: started } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input, clientMessageId: `${label}-${Date.now()}` });
    const answered = new Set<string>();
    const deadline = Date.now() + TURN_MS;
    for (;;) {
      const fresh = phone.messages.slice(before);
      for (const m of fresh) {
        if (m.method !== 'approval/request') continue;
        const request = (m.params as { request: { requestId: string; command?: string } }).request;
        if (answered.has(request.requestId)) continue;
        answered.add(request.requestId);
        const decision = (request.command ?? '').includes(attachmentsDir(config)) ? 'accept' : 'decline';
        step(`${label}: approval ${JSON.stringify(request.command ?? request)} -> ${decision}`);
        await rpc(phone, 'approval/resolve', { sessionId, requestId: request.requestId, decision });
      }
      const done = fresh.find((m) => m.method === 'turn/completed' && (m.params as { turn: { turnId: string } }).turn.turnId === started.turnId);
      if (done) {
        const status = (done.params as { turn: { status: string; error: unknown } }).turn;
        const texts = fresh
          .filter((m) => m.method === 'item/completed')
          .map((m) => (m.params as { item: { type: string; text?: string } }).item)
          .filter((item) => item.type === 'agentMessage')
          .map((item) => item.text ?? '');
        const reply = texts.join('\n').trim();
        step(`${label}: turn ${status.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s${status.error ? ` error ${JSON.stringify(status.error)}` : ''}; reply: ${JSON.stringify(reply)}`);
        expect(status.status).toBe('completed');
        return reply;
      }
      if (Date.now() > deadline) throw new Error(`${label}: no turn/completed within ${TURN_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  for (const agentId of ['codex', 'pi'] as const) {
    it(
      `${agentId}: describes the uploaded image and reads the uploaded file`,
      async () => {
        const cwd = realpathSync(mkdtempSync(path.join(home, `work-${agentId}-`)));
        const settings = agentId === 'pi' ? { model: PI_MODEL } : {};
        const { session } = await rpc<{ session: { sessionId: string; settings: unknown } }>(phone, 'session/start', { agentId, cwd, settings });
        const sessionId = session.sessionId;
        await rpc(phone, 'session/open', { sessionId });
        step(`${agentId}: session ${sessionId} settings ${JSON.stringify(session.settings)} cwd ${cwd}`);

        const image = await upload(sessionId, 'red-blue.png', 'image/png', redBluePng());
        const described = await turn(sessionId, [{ type: 'text', text: IMAGE_PROMPT }, { type: 'image', url: image.url }], `${agentId} image`);
        expect(described).toMatch(/red/i);
        expect(described).toMatch(/blue/i);

        const file = await upload(sessionId, 'code-word.txt', 'text/plain', Buffer.from(`The code word is ${CODE_WORD}.\n`));
        const read = await turn(
          sessionId,
          [{ type: 'text', text: FILE_PROMPT }, { type: 'file', url: file.url, name: file.name, mediaType: file.mediaType }],
          `${agentId} file`,
        );
        expect(read).toContain(CODE_WORD);

        await rpc(phone, 'session/delete', { sessionId });
        const gone = await fetch(`${base}${image.url}`, { headers: { authorization: `Bearer ${token}` } });
        step(`${agentId}: session deleted; ${image.url} now answers ${gone.status}`);
        expect(gone.status).toBe(404);
      },
      2 * TURN_MS + 60_000,
    );
  }
});

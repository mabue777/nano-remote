// The scripted phone session, identical for every agent:
//   session/start -> turn/start -> approval/request -> approval/resolve(accept) -> turn/completed
//   -> phone goes offline (keeps its cursor) -> engine SIGKILLed -> new engine resumes the session
//   -> a follow-up turn runs while the phone is offline -> session/open {cursor} delivers the catch-up.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
// Copied from spikes/host-drive/src/scenario.ts; changes: work root and log name parameter.
import { FakePhone, Host, type Adapter, type Ev } from "./host.ts";
import { StepLog, Trace, WORK_ROOT } from "./log.ts";

export const FIRST_PROMPT =
  "Create a file named hello.txt in the current directory containing exactly the word hello. Do it now; do not ask questions.";
export const FOLLOW_UP_PROMPT =
  "Without using any tools: what is the exact name of the file you created in this conversation? Reply with the file name only.";

export async function runScenario(agentId: string, logName: string, trace: Trace, makeAdapter: (cwd: string) => Adapter): Promise<void> {
  const log = new StepLog(logName);
  const cwd = join(WORK_ROOT, logName);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });

  const host = new Host(makeAdapter(cwd), trace);
  const phone = new FakePhone(host);
  const isTurnDone = (e: Ev) => e.method === "turn/completed";

  // 1. session/start
  const { session } = await phone.call("session/start", { agentId, cwd });
  log.step("session/start", `ok sessionId=${session.sessionId} engineSession=${host.engineSessionId} cwd=${cwd} enginePid=${host.adapter.pid()}`);

  // 2. turn/start
  const { turn } = await phone.call("turn/start", {
    sessionId: session.sessionId,
    input: [{ type: "text", text: FIRST_PROMPT }],
    clientMessageId: randomUUID(),
  });
  log.step("turn/start", `ok turnId=${turn.turnId} engineSession=${host.engineSessionId} prompt="${FIRST_PROMPT.slice(0, 60)}..."`);

  // 3. approval/request (event, delivered live to the phone)
  const approval = await phone.waitFor((e) => e.method === "approval/request" || isTurnDone(e));
  if (approval.method !== "approval/request") throw new Error(`turn ended without approval: ${JSON.stringify(approval.params.turn)}`);
  const r = approval.params.request;
  log.step(
    "approval/request received",
    `seq=${approval.params.seq} requestId=${r.requestId} kind=${r.kind} engineMethod=${r.engineMethod} ` +
      `${r.command ? `command=${JSON.stringify(r.command)}` : `changes=${JSON.stringify(r.changes ?? r.toolInput ?? null).slice(0, 160)}`} ` +
      `availableDecisions=${r.availableDecisions.join(",")}`,
  );

  // 4. approval/resolve accept
  const ack = await phone.call("approval/resolve", { sessionId: session.sessionId, requestId: r.requestId, decision: "accept" });
  log.step("approval/resolve (accept) sent", `requestId=${r.requestId} reply=${JSON.stringify(ack)}`);

  // 5. turn/completed, seen live by the phone
  const done = await phone.waitFor(isTurnDone);
  const file = join(cwd, "hello.txt");
  const content = existsSync(file) ? readFileSync(file, "utf8").trim() : "<missing>";
  log.step(
    "turn/completed",
    `seq=${done.params.seq} turnId=${done.params.turn.turnId} status=${done.params.turn.status} hello.txt=${JSON.stringify(content)}`,
  );

  // 6. phone goes offline holding its cursor; the engine process is killed hard
  const cursor = phone.lastApplied;
  host.disconnect();
  const killed = await host.adapter.kill();
  log.step("process killed", `pid=${killed.pid} signal=${killed.signal} exitCode=${killed.code} phoneOffline cursor=${cursor}`);

  // 7. a fresh engine process reattaches to the same engine session
  const fresh = makeAdapter(cwd);
  host.attach(fresh);
  const resumedId = await fresh.resume(host.engineSessionId, cwd);
  if (resumedId !== host.engineSessionId) throw new Error(`resume returned ${resumedId}, expected ${host.engineSessionId}`);
  // Prove the resumed engine has the conversation: a follow-up turn while the phone is offline.
  const followDone = host.waitFor((e) => isTurnDone(e) && e.params.seq > cursor);
  const followTurn = await host.request("turn/start", {
    sessionId: session.sessionId,
    input: [{ type: "text", text: FOLLOW_UP_PROMPT }],
    clientMessageId: randomUUID(),
  });
  await followDone;
  const confirmed = fresh.engineSessionId?.() ?? resumedId;
  if (confirmed !== host.engineSessionId) throw new Error(`engine reports session ${confirmed} after resume, expected ${host.engineSessionId}`);
  log.step(
    "session resumed",
    `newPid=${fresh.pid()} engineSession=${confirmed} (same id) ${fresh.resumeInfo ?? ""}; follow-up turnId=${followTurn.turn.turnId} ran while phone offline, journal head=${host.head()}`,
  );

  // 8. phone reconnects: session/open with its cursor, events mode
  const opened = await phone.call("session/open", { sessionId: session.sessionId, cursor });
  for (const ev of opened.events) phone.onEvent(ev);
  const methods = opened.events.map((e: Ev) => e.method);
  const reply = opened.events
    .filter((e: Ev) => e.method === "item/completed" && e.params.item.type === "agentMessage")
    .map((e: Ev) => e.params.item.text)
    .pop();
  const counts = Object.entries(methods.reduce((m: Record<string, number>, k: string) => ((m[k] = (m[k] ?? 0) + 1), m), {}))
    .map(([k, v]) => `${k}x${v}`)
    .join(" ");
  log.step(
    "catch-up delivered",
    `session/open mode=${opened.mode} cursor ${cursor}->${opened.cursor} events=${opened.events.length} [${counts}] ` +
      `pendingApprovals=${opened.pending.approvals.length} phone.lastApplied=${phone.lastApplied} followUpReply=${JSON.stringify(reply ?? "")}`,
  );

  await fresh.kill().catch(() => undefined);
}

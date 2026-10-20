// Which tools reach canUseTool? One turn per tool, every request auto-accepted, two settings profiles:
//   isolated: settingSources [] + permissionMode "default" (what the spike's adapter uses)
//   operator: settingSources ["user"], no permissionMode (this machine's real settings: defaultMode auto,
//             AskUserQuestion in permissions.deny)
// Writes logs/claude-probe.log.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter, type ClaudeOptions } from "./claude.ts";
import { LOG_DIR, Trace, now, type Ev } from "./host.ts";

const out = join(LOG_DIR, "claude-probe.log");
writeFileSync(out, "");
const line = (s: string) => (appendFileSync(out, `${now()}  ${s}\n`), console.log(s));
const trace = new Trace("claude-probe");

const TURNS: Array<[string, string]> = [
  ["Bash", "Use the Bash tool to run exactly this command and nothing else: mkdir -p probe && echo bash > probe/bash.txt"],
  ["Write", "Use the Write tool to create the file write.txt containing exactly: write"],
  ["AskUserQuestion", "Use the AskUserQuestion tool to ask me one question: which color do I prefer, with the options red and blue. Then reply with only the color I chose."],
];

async function profile(name: string, opts: ClaudeOptions): Promise<void> {
  const cwd = join("/tmp", "nano-host-drive", `probe-${name}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const a = new ClaudeAdapter(trace, opts);
  a.answerQuestions = (input) => Object.fromEntries((input.questions ?? []).map((q: any) => [q.question, q.options?.[1]?.label ?? "blue"]));
  const events: Ev[] = [];
  let done: (() => void) | undefined;
  a.onEvent = (ev) => {
    events.push(ev);
    if (ev.method === "approval/request") a.resolve(ev.params.request.requestId, "accept");
    if (ev.method === "turn/completed") done?.();
  };
  await a.start(cwd);
  for (const [tool, prompt] of TURNS) {
    const before = a.canUseToolCalls.length;
    const firstEv = events.length;
    const finished = new Promise<void>((r) => (done = r));
    await a.startTurn(prompt, tool);
    await finished;
    const fired = a.canUseToolCalls.slice(before).map((c) => c.toolName);
    const turnEvents = events.slice(firstEv);
    const used = turnEvents.filter((e) => e.method === "item/started").map((e) => e.params.item.tool ?? e.params.item.type);
    const results = turnEvents
      .filter((e) => e.method === "item/completed" && e.params.item.type === "toolCall")
      .map((e) => `${e.params.item.status}:${JSON.stringify(e.params.item.result).slice(0, 140)}`);
    const reply = turnEvents.filter((e) => e.method === "item/completed" && e.params.item.type === "agentMessage").map((e) => e.params.item.text).pop();
    line(
      `profile=${name} asked=${tool} canUseTool fired for [${fired.join(",") || "nothing"}] ` +
        `itemsStarted=[${used.join(",")}] toolResults=[${results.join(" | ")}] reply=${JSON.stringify((reply ?? "").slice(0, 160))}`,
    );
  }
  await a.kill();
}

await profile("isolated", { settingSources: [], permissionMode: "default" });
await profile("operator", { settingSources: ["user"] });
process.exit(0);

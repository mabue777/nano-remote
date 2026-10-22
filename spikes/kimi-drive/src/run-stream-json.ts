// The route the ticket asked about: `kimi --prompt ... --output-format stream-json`, no --yolo.
// One process per prompt; stdout is newline-delimited JSON. Model = the local scripted fake.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "./fake-model.ts";
import { KIMI_BIN, StepLog, Trace, fakeHome, freshDir } from "./log.ts";
import { FIRST_PROMPT, FOLLOW_UP_PROMPT } from "./scenario.ts";

const log = new StepLog("kimi-stream-json");
const trace = new Trace("kimi-stream-json");
const APPROVAL_RE = /approv|permission|request_permission|confirm/i;

type Run = { args: string[]; code: number | null; signal: string | null; events: any[]; stderr: string; pid: number };

function runKimi(home: string, cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(KIMI_BIN, args, { cwd, env: { ...process.env, KIMI_CODE_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    trace.write("spawn", { args, pid: p.pid });
    let out = "";
    let stderr = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("exit", (code, signal) => {
      clearTimeout(timer);
      const events = out.split("\n").filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { unparsed: l };
        }
      });
      for (const e of events) trace.write("kimi->stdout", e);
      if (stderr) trace.write("kimi->stderr", stderr.slice(0, 2000));
      resolve({ args, code, signal, events, stderr, pid: p.pid! });
    });
  });
}

const kinds = (r: Run) =>
  r.events.map((e) => (e.role === "meta" ? `meta:${e.type}` : e.tool_calls ? `assistant(tool_calls:${e.tool_calls.map((c: any) => c.function.name).join(",")})` : e.role)).join(" ");
const approvalLike = (r: Run) => r.events.filter((e) => APPROVAL_RE.test(JSON.stringify(e))).length + (APPROVAL_RE.test(r.stderr) ? 1 : 0);
const sessionOf = (r: Run) => r.events.find((e) => e.type === "session.resume_hint")?.session_id ?? "";
const fileState = (cwd: string) => (existsSync(join(cwd, "hello.txt")) ? JSON.stringify(readFileSync(join(cwd, "hello.txt"), "utf8")) : "<missing>");

async function scenario(label: string, rulesToml: string): Promise<void> {
  const cwd = freshDir(`kimi-stream-json-${label}`);
  const model = await startFakeModel(trace, join(cwd, "hello.txt"));
  const home = fakeHome(`kimi-stream-json-${label}`, model.url, rulesToml);
  const flags = ["--model", "fake/fake-coder", "--output-format", "stream-json"];

  const first = await runKimi(home, cwd, [...flags, "--prompt", FIRST_PROMPT]);
  const sid = sessionOf(first);
  log.step(
    `[${label}] turn needing a file write`,
    `flags="${flags.join(" ")} --prompt <text>" exit=${first.code} engineSession=${sid} events=[${kinds(first)}] approvalLikeEvents=${approvalLike(first)} hello.txt=${fileState(cwd)}`,
  );
  if (label !== "default") return void (await model.close());

  // The process already exited after its one turn: there is no live engine to SIGKILL between turns.
  // Resume = a new process with --session <id> and the next prompt.
  const resumed = await runKimi(home, cwd, [...flags, "--session", sid, "--prompt", FOLLOW_UP_PROMPT]);
  const reply = resumed.events.filter((e) => e.role === "assistant" && typeof e.content === "string").map((e) => e.content).pop();
  log.step(
    `[${label}] resume with --session`,
    `exit=${resumed.code} engineSession=${sessionOf(resumed)} (same=${sessionOf(resumed) === sid}) events=[${kinds(resumed)}] reply=${JSON.stringify(reply ?? "")}`,
  );
  await model.close();
}

await scenario("default", "");
await scenario("ask-rule", `[[permission.rules]]\ndecision = "ask"\npattern = "Write"\n`);
await scenario("deny-rule", `[[permission.rules]]\ndecision = "deny"\npattern = "Write"\n`);

// Flag conflict check: prompt mode refuses to combine with a permission mode at all.
const conflict = await runKimi(freshDir("kimi-stream-json-conflict-home"), freshDir("kimi-stream-json-conflict"), ["--model", "fake/fake-coder", "--output-format", "stream-json", "--yolo", "--prompt", "x"]);
log.step("flag check --prompt with --yolo", `exit=${conflict.code} stderr=${JSON.stringify(conflict.stderr.trim().split("\n")[0] ?? "")}`);
process.exit(0);

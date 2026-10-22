// The real account: the operator's own ~/.kimi-code (saved login), models from provider managed:kimi-code
// only. One attempt per route; never retried, never `kimi login`. Prints no config values.
import { spawn } from "node:child_process";
import { AcpClient } from "./acp.ts";
import { KIMI_BIN, StepLog, Trace, freshDir } from "./log.ts";

const log = new StepLog("kimi-managed");
const trace = new Trace("kimi-managed");
const MODELS = ["kimi-code/kimi-for-coding-highspeed", "kimi-code/kimi-for-coding"];
const PROMPT = "Reply with the single word pong.";
const firstErr = (s: string) => JSON.stringify(s.trim().split("\n").find((l) => /error/i.test(l)) ?? s.trim().split("\n")[0] ?? "");

for (const model of MODELS) {
  const cwd = freshDir("kimi-managed");
  const args = ["--model", model, "--output-format", "stream-json", "--prompt", PROMPT];
  const r = await new Promise<{ code: number | null; out: string; err: string }>((res) => {
    const p = spawn(KIMI_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => res({ code, out, err }));
  });
  trace.write("stream-json", { args, code: r.code, stdout: r.out, stderr: r.err });
  log.step(`stream-json ${model}`, `exit=${r.code} stdout=${JSON.stringify(r.out.trim())} stderr=${firstErr(r.err)}`);
}

// ACP: session start needs no model call; the first prompt does.
const cwd = freshDir("kimi-managed-acp");
const c = new AcpClient(trace, {}, cwd);
const init = await c.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "nano-kimi-drive-spike", version: "0.0.0" } });
log.step("acp initialize", `ok agent=${init.agentInfo?.name} ${init.agentInfo?.version} loadSession=${init.agentCapabilities?.loadSession} authMethods=${(init.authMethods ?? []).map((m: any) => m.id).join(",")}`);
const ses = await c.call("session/new", { cwd, mcpServers: [] });
const modelOpt = (ses.configOptions ?? []).find((o: any) => o.id === "model");
const managedOffered = (modelOpt?.options ?? []).map((o: any) => o.value).filter((v: string) => v.startsWith("kimi-code/"));
log.step("acp session/new", `ok engineSession=${ses.sessionId} mode=${ses.modes?.currentModeId} managedModelsOffered=${managedOffered.join(",")}`);
const set = await c.call("session/set_config_option", { sessionId: ses.sessionId, configId: "model", value: MODELS[0] }).then(
  (r) => `ok currentValue=${(r?.configOptions ?? []).find((o: any) => o.id === "model")?.currentValue}`,
  (e) => `error ${e.message}`,
);
log.step("acp session/set_config_option model", `${MODELS[0]} -> ${set}`);
const prompt = await c.call("session/prompt", { sessionId: ses.sessionId, prompt: [{ type: "text", text: PROMPT }] }).then(
  (r) => `result=${JSON.stringify(r)}`,
  (e) => `error=${JSON.stringify(e.rpc ?? e.message).slice(0, 400)}`,
);
const said = c.notifications.filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk").map((n) => n.params.update.content?.text ?? "").join("");
log.step("acp session/prompt", `${prompt} agentText=${JSON.stringify(said.slice(0, 200))}`);
await c.kill();
process.exit(0);

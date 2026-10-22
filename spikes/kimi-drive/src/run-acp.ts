// Full scripted phone session against `kimi acp`.
// Default: model = the local scripted fake, isolated KIMI_CODE_HOME (see NOTES.md for why).
// SPIKE_KIMI_LIVE=1: the operator's own ~/.kimi-code and a managed:kimi-code model instead; writes
// logs/kimi-acp-live.log. On 2026-10-22 this account got 403 (no Kimi Code subscription), see kimi-managed.log.
import { join } from "node:path";
import { startFakeModel } from "./fake-model.ts";
import { KimiAcpAdapter } from "./kimi-acp.ts";
import { Trace, WORK_ROOT, fakeHome } from "./log.ts";
import { runScenario } from "./scenario.ts";

if (process.env.SPIKE_KIMI_LIVE === "1") {
  const model = process.env.SPIKE_KIMI_MODEL ?? "kimi-code/kimi-for-coding-highspeed";
  const trace = new Trace("kimi-acp-live");
  await runScenario("kimi", "kimi-acp-live", trace, (cwd) => new KimiAcpAdapter(trace, {}, cwd, model));
} else {
  const trace = new Trace("kimi-acp");
  const model = await startFakeModel(trace, join(WORK_ROOT, "kimi-acp", "hello.txt"));
  const home = fakeHome("kimi-acp", model.url);
  await runScenario("kimi", "kimi-acp", trace, (cwd) => new KimiAcpAdapter(trace, { KIMI_CODE_HOME: home }, cwd));
  console.log(`fake model served ${model.requests} chat requests`);
  await model.close();
}
process.exit(0);

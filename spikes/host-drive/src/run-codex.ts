import { CodexAdapter } from "./codex.ts";
import { Trace } from "./host.ts";
import { runScenario } from "./scenario.ts";

const trace = new Trace("codex");
await runScenario("codex", () => new CodexAdapter(trace));
process.exit(0);

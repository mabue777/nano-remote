import { ClaudeAdapter } from "./claude.ts";
import { Trace } from "./host.ts";
import { runScenario } from "./scenario.ts";

const trace = new Trace("claude");
await runScenario("claude", () => new ClaudeAdapter(trace));
process.exit(0);

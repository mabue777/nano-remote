// What an agent supports, from `Agent.capabilities` in `initialize` and `agent/list` (spec 4). The screens
// show only the controls an agent supports. An agent without `capabilities` comes from an older host (or
// is not known yet): every answer is then "yes", which is how the app behaved before capabilities existed,
// and the host's `not_supported` still has the last word.
import type { Agent } from '../generated/common';

/** "Bypass approvals" is offered: the agent honours approvalMode `never`. */
export function canBypass(agent: Agent | undefined): boolean {
  const capabilities = agent?.capabilities;
  return capabilities === undefined || capabilities.approvalModes.includes('never');
}

/** turn/steer works while a turn runs. */
export function canSteer(agent: Agent | undefined): boolean {
  return agent?.capabilities?.steer ?? true;
}

/** turn/diff works (the Changes view). */
export function hasDiff(agent: Agent | undefined): boolean {
  return agent?.capabilities?.diff ?? true;
}

/** The agents the screens consult; the stream client's `initialize` result fits (`() => client.host?.agents`). */
export type AgentsSource = () => readonly Agent[] | undefined;

export function findAgent(agents: AgentsSource | undefined, agentId: string | undefined): Agent | undefined {
  if (agents === undefined || agentId === undefined) return undefined;
  return agents()?.find((agent) => agent.id === agentId);
}

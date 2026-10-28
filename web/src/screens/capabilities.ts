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

/** "Accept edits" is offered: the agent honours approvalMode `acceptEdits` (Claude Code, Pi). */
export function canAcceptEdits(agent: Agent | undefined): boolean {
  return agent?.capabilities?.approvalModes.includes('acceptEdits') ?? false;
}

/** turn/steer works while a turn runs. */
export function canSteer(agent: Agent | undefined): boolean {
  return agent?.capabilities?.steer ?? true;
}

/** turn/diff works (the Changes view). */
export function hasDiff(agent: Agent | undefined): boolean {
  return agent?.capabilities?.diff ?? true;
}

/**
 * Which attachments (spec 8.1) the composer offers for the agent: none unless the host takes uploads
 * (`limits.maxAttachmentBytes`) and the agent declares `capabilities.attachments` with images or files.
 * Unlike the other controls this one is never guessed for an older host: it would only upload into a 404.
 */
export function attachmentsFor(agent: Agent | undefined, maxBytes: number | undefined): { images: boolean; files: boolean } | undefined {
  const attachments = agent?.capabilities?.attachments;
  if (maxBytes === undefined || attachments === undefined || (!attachments.images && !attachments.files)) return undefined;
  return { images: attachments.images, files: attachments.files };
}

/** A setting an open session can change (spec 6 session/settings/update). */
export type SettingsKey = 'model' | 'effort';

/**
 * What an open session of the agent can change (`capabilities.settingsUpdate`, spec 4). Never guessed for
 * an older host: without the capability the session view offers no way to change them.
 */
export function settingsKeys(agent: Agent | undefined): readonly SettingsKey[] {
  return (agent?.capabilities?.settingsUpdate ?? []).filter((key): key is SettingsKey => key === 'model' || key === 'effort');
}

/**
 * The approval modes an open session of the agent can switch between (`capabilities.settingsUpdate` names
 * `approvalMode`, spec 6): its `capabilities.approvalModes`. Empty when it cannot and,
 * never guessed, for an older host: the Permissions row then stays plain text.
 */
export function changeableApprovalModes(agent: Agent | undefined): readonly string[] {
  const capabilities = agent?.capabilities;
  if (capabilities?.settingsUpdate?.includes('approvalMode') !== true) return [];
  return capabilities.approvalModes;
}

/** The agents the screens consult; the stream client's `initialize` result fits (`() => client.host?.agents`). */
export type AgentsSource = () => readonly Agent[] | undefined;

export function findAgent(agents: AgentsSource | undefined, agentId: string | undefined): Agent | undefined {
  if (agents === undefined || agentId === undefined) return undefined;
  return agents()?.find((agent) => agent.id === agentId);
}

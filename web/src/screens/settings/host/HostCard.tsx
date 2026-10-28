// Settings, the paired host under "This Mac": its name (a sub-heading), uptime (or version) and active count,
// and each agent with its state. It was Home's host card until look step 6 made Home the flat session list. Rules: HostStatusModel
// (screens/host-status-model.ts). Styles: .host, .agents, .agent in HomeScreen.css.
import { useEffect, useMemo } from 'preact/hooks';

import { HostStatusModel, type HostStatusClient } from '../../host-status-model';
import { useModel } from '../../use-model';

export function HostCard({ client }: { client: HostStatusClient }) {
  const model = useModel(useMemo(() => new HostStatusModel({ client }), [client]));
  useEffect(() => () => model.dispose(), [model]);
  const host = model.view;
  if (host === undefined) {
    return (
      <section class="card host" aria-label="Host">
        <p class="muted">Waiting for the host…</p>
      </section>
    );
  }
  return (
    <section class="card host" aria-label="Host">
      <div class="host-line">
        <h3 class="host-name">{host.name}</h3>
        <span class="muted small">
          {host.uptime !== undefined ? `up ${host.uptime}` : `v${host.version}`}
          {host.sessionsActive !== undefined && host.sessionsActive > 0 ? ` · ${host.sessionsActive} active` : ''}
        </span>
      </div>
      <ul class="agents" aria-label="Agents">
        {host.agents.map((agent) => (
          <li key={agent.id} class={`agent ${agent.tone}`} title={agent.detail}>
            <span class="dot" aria-hidden="true" />
            <span class="agent-name">{agent.name}</span>
            <span class="agent-status muted small">{agent.status === 'ready' ? 'ready' : agent.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

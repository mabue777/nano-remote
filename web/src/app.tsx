import { PROTOCOL_VERSION, appTitle } from './version';

export function App() {
  return (
    <main>
      <h1>{appTitle()}</h1>
      <p>
        Phone client scaffold, protocol v{PROTOCOL_VERSION}. Nano Host serves this page from
        host/public.
      </p>
    </main>
  );
}

// The base of the screen view models: plain classes that hold what a screen shows, bump `version` and
// call subscribers after every change. Components re-read on change (useModel); tests read directly.

export class Model {
  private versionValue = 0;
  private readonly listeners = new Set<() => void>();

  get version(): number {
    return this.versionValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected changed(): void {
    this.versionValue += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The message of a failure for a screen: RequestError and Error messages, else a generic line. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Something went wrong.';
}

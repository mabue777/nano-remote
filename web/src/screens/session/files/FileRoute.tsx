// /s/<id>/file: loads the file viewer in its own chunk (like the lab), so the app's first load carries none of
// it. `preloadFileViewer` starts that load early (when a session opens), so a push rarely waits for it.
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { FileViewerProps } from './FileViewer';

let loading: Promise<ComponentType<FileViewerProps>> | undefined;

export function preloadFileViewer(): Promise<ComponentType<FileViewerProps>> {
  loading ??= import('./FileViewer').then((module) => module.FileViewer);
  return loading;
}

export function FileRoute(props: FileViewerProps) {
  const [Viewer, setViewer] = useState<ComponentType<FileViewerProps> | null>(null);
  useEffect(() => {
    let live = true;
    void preloadFileViewer().then((component) => live && setViewer(() => component));
    return () => {
      live = false;
    };
  }, []);
  return Viewer === null ? <main class="screen" aria-busy="true" /> : <Viewer {...props} />;
}

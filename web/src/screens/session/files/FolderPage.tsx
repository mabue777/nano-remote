// The Files page of a session (docs/plan/file-viewer.md item P6): a pushed page listing one level of the
// session folder. Files-app rows (icon, name, grey meta line, chevron on folders), folders first, a
// "Show hidden files" switch at the bottom, pull-to-refresh, and a dot + "changed" on files the last turn
// touched. Tapping a folder pushes the next level; tapping a file opens the text viewer or the image viewer.
//
// The page is part of the main bundle (just a list), so no lazy route is needed.
// Styles: files.css.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { GroupList, type GroupRow } from '../../../ui/GroupList';
import { NavHeader } from '../../../ui/NavHeader';
import { PullIndicator, usePullToRefresh } from '../../../ui/PullToRefresh';
import { Switch } from '../../../ui/Switch';
import { imageViewer } from '../../../ui/image-viewer-launch';
import { useModel } from '../../use-model';
import { fileUrl } from './file-model';
import { folderName, folderSubtitle, FolderModel, type FolderEntry, type FolderReplica, type FolderReader } from './folder-model';

export interface FolderPageProps {
  sessionId: string;
  path: string;
  reader: FolderReader;
  replica: FolderReplica;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** The session folder's name for the subtitle at the root. */
  sessionFolder?: { name(): string | undefined; subscribe(listener: () => void): () => void };
  /** Push a folder page one level deeper, or the file viewer for a file. */
  onOpen: (route: { name: 'folder' | 'file'; path: string }) => void;
  onBack: () => void;
}

function useFolderName(source: { name(): string | undefined; subscribe(listener: () => void): () => void } | undefined): string | undefined {
  const [name, setName] = useState(() => source?.name());
  useEffect(() => {
    if (source === undefined) return;
    setName(source.name());
    return source.subscribe(() => setName(source.name()));
  }, [source]);
  return name;
}

export function FolderPage({ sessionId, path, reader, replica, storage, sessionFolder, onOpen, onBack }: FolderPageProps) {
  const folderNameValue = useFolderName(sessionFolder);
  const model = useMemo(
    () => new FolderModel({ sessionId, path, reader, replica, storage }),
    // A new folder is a new page (PageStack keys pages by path); the reader/replica/storage never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, path],
  );
  useModel(model);
  useEffect(() => {
    void model.load();
    return () => model.dispose();
  }, [model]);

  const list = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh(() => (list.current?.scrollTop ?? 0) <= 0, () => void model.refresh());

  const state = model.state;
  const title = model.title;
  const subtitle = folderSubtitle(path, folderNameValue ?? 'Session folder');

  const rows = useMemo((): GroupRow[] => {
    if (state.state !== 'ready') return [];
    return state.entries.map((entry) => entryRow({ sessionId, entry, onOpen }));
  }, [state, sessionId, onOpen]);

  return (
    <main class="screen folder-page">
      <div class="folder-top">
        <NavHeader
          href={`/s/${encodeURIComponent(sessionId)}`}
          backLabel="Session"
          onBack={onBack}
          title={title}
          moreLabel="Folder actions"
          onMore={() => undefined}
        >
          <span class="file-folder">{subtitle}</span>
        </NavHeader>
        <PullIndicator distance={pull.distance} pullLabel="Pull to refresh" releaseLabel="Release to refresh" />
      </div>
      <div
        ref={list}
        class="folder-list"
        {...pull.handlers}
      >
        {state.state === 'loading' && rows.length === 0 && (
          <p class="folder-status muted" role="status">
            Loading…
          </p>
        )}
        {state.state === 'error' && (
          <div class="folder-status" role="alert">
            <p class="error">{state.message}</p>
            <button type="button" onClick={() => void model.load()}>
              Try again
            </button>
          </div>
        )}
        {state.state === 'ready' && rows.length === 0 && (
          <p class="folder-status muted" role="status">
            This folder is empty.
          </p>
        )}
        {rows.length > 0 && <GroupList label="Files" rows={rows} />}
        {state.state === 'ready' && state.capped > 0 && (
          <p class="folder-cap" role="status">
            {state.capped} more {state.capped === 1 ? 'item' : 'items'} not shown
          </p>
        )}
        {state.state === 'ready' && (
          <div class="folder-hidden">
            <span id="hidden-label">Show hidden files</span>
            <Switch labelledBy="hidden-label" checked={model.hidden} onChange={() => model.toggleHidden()} />
          </div>
        )}
      </div>
    </main>
  );
}

function entryRow({
  sessionId,
  entry,
  onOpen,
}: {
  sessionId: string;
  entry: FolderEntry;
  onOpen: FolderPageProps['onOpen'];
}): GroupRow {
  const value: Array<GroupRow['value'][number]> = [];
  if (entry.meta !== '') value.push({ text: entry.meta });
  if (entry.changed) value.push({ text: 'changed', label: 'Changed in the last turn', class: 'status-word' });
  return {
    key: entry.path,
    icon: entry.kind === 'dir' ? 'folder' : isImage(entry.name) ? 'image' : 'file',
    label: entry.name,
    value,
    opens: entry.kind === 'dir',
    onClick: () => {
      if (entry.kind === 'dir') {
        onOpen({ name: 'folder', path: entry.path });
        return;
      }
      if (isImage(entry.name)) {
        imageViewer.open({
          images: [{ src: fileUrl(sessionId, entry.path), alt: entry.name, name: entry.name }],
          index: 0,
          origin: () => null,
        });
        return;
      }
      onOpen({ name: 'file', path: entry.path });
    },
  };
}

function isImage(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'heic' || ext === 'heif' || ext === 'avif';
}

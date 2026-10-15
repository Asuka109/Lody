// @vitest-environment jsdom

// Two rules this hook must not get wrong:
//
// 1. Reaching a shell needs a RESOLVED host path, not merely "Electron on the
//    owning machine". While that machine's path metadata loads, the local-host
//    actions can only fail — and the download that would have worked must not
//    be hidden behind them.
// 2. A machine that serves `file/read-range` downloads any file up to its
//    ceiling in bounded ranges, one revision or nothing. Without it, the
//    fallback reads through the preview API's ONE bounded response, so it cannot
//    serve a file past those limits — exactly the file whose error card sent the
//    user looking. It must SAY that: a generic "could not download" reads as a
//    glitch worth retrying.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore, Provider } from 'jotai';
import type { FileReadRangeRequest, FileReadRangeResponse, MachineMeta } from '@lody/shared';

// The machine's own path metadata: `null` is the state right after mount, when
// the Flock rows for that machine have not arrived yet.
let localHomeDir: string | null = '/home/dev';
let localMachineId: string | null = null;
let nativeShell = false;
let sharedBytes: Uint8Array | undefined;
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => nativeShell }));
vi.mock('../src/lib/session-file-native-save', () => ({
  shareFileBytesNatively: async (_name: string, bytes: Uint8Array) => {
    sharedBytes = bytes;
  },
}));

vi.mock('../src/atoms/local-probe', () => ({
  localHomeDirAtom: atom(() => localHomeDir),
  localMachineIdAtom: atom(() => localMachineId),
}));

// Only the transport the ranged download needs; `null` is "no workspace runtime".
type RangeRuntime = {
  requestFileReadRange: (
    machineId: string,
    request: Omit<FileReadRangeRequest, 'v'>,
    options?: { ownerSessionId?: string }
  ) => Promise<FileReadRangeResponse>;
};
let rangeRuntime: RangeRuntime | null = null;
vi.mock('../src/atoms/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atoms/runtime')>()),
  activeWorkspaceRuntimeAtom: atom(() => rangeRuntime),
}));

// `../src/atoms` is deliberately NOT mocked: it is a barrel half the graph
// imports, and the real machine-meta family already answers `null` for a
// machine no store knows about, which is the state under test.

const revealLocalPath = vi.fn(
  async (_path: string): Promise<{ revealed: boolean; error?: string }> => ({ revealed: true })
);
const openLocalPath = vi.fn(
  async (_path: string): Promise<{ opened: boolean; error?: string }> => ({ opened: true })
);
const launchLocalPath = vi.fn(
  async (_input: unknown): Promise<{ launched: boolean; error?: string; command?: string }> => ({
    launched: true,
  })
);
const probePathLaunchers = vi.fn(async (payload: { launchers: Array<{ launcherId: string }> }) => ({
  availableIds: payload.launchers.map((launcher) => launcher.launcherId),
}));
let bridgeAvailable = true;
const writeTextToClipboard = vi.fn(async (_text: string) => true);
vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: (text: string) => writeTextToClipboard(text),
}));
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () =>
    bridgeAvailable
      ? { app: { revealLocalPath, openLocalPath, launchLocalPath, probePathLaunchers } }
      : null,
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastShow = vi.fn();
const toastDismiss = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: Object.assign((...args: unknown[]) => toastShow(...args), {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    dismiss: (...args: unknown[]) => toastDismiss(...args),
  }),
}));

const downloadBytesAsFile = vi.fn();
const downloadPartsAsFile = vi.fn();
vi.mock('../src/lib/download-file', () => ({
  downloadBytesAsFile: (...args: unknown[]) => downloadBytesAsFile(...args),
  downloadPartsAsFile: (...args: unknown[]) => downloadPartsAsFile(...args),
  getDownloadFileName: (path: string) => path,
}));

vi.mock('../src/hooks/use-machine-flock-rows', () => ({
  useMachineFlockRows: () => ({}),
}));

import { getMachineRoomId, type MachineId, type SessionMeta } from '@lody/shared';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import {
  useSessionFileActions,
  type SessionFileActions,
} from '../src/hooks/use-session-file-actions';
import type { FileWorkspaceOpenResult } from '../src/lib/file-workspace-provider';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  id: 'session-download',
  machineId: 'machine-remote',
  createdAt: '2026-05-09T00:00:00.000Z',
  userId: 'user-1',
} as unknown as SessionMeta;

describe('remote file download action', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    toastError.mockClear();
    downloadBytesAsFile.mockClear();
    nativeShell = false;
    sharedBytes = undefined;
    localHomeDir = '/home/dev';
    localMachineId = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    nativeShell = false;
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  const runDownload = async (openResult: FileWorkspaceOpenResult): Promise<void> => {
    const fileProvider = { openFile: async () => openResult };
    let download: ((filePath: string) => void) | null = null;
    function Probe() {
      download = useSessionFileActions({ session, fileProvider }).download;
      return null;
    }
    await act(async () => {
      root?.render(createElement(Provider, null, createElement(Probe)));
    });
    expect(download).not.toBeNull();
    await act(async () => {
      download?.('docs/huge.log');
    });
  };

  it('offers native notice sharing only with complete binary bytes, including empty files', async () => {
    nativeShell = true;
    let actions!: SessionFileActions;
    function Probe() {
      actions = useSessionFileActions({
        session,
        fileProvider: {
          openFile: async () => ({ status: 'unavailable', reason: 'blob-too-large' }),
        },
      });
      return null;
    }
    await act(async () => {
      root?.render(createElement(Provider, null, createElement(Probe)));
    });
    expect(actions.buildErrorActions('large.deb')?.onShare).toBeUndefined();
    expect(actions.buildErrorActions('metadata.deb', { kind: 'binary' })?.onShare).toBeUndefined();
    expect(
      actions.buildErrorActions('empty.deb', { kind: 'binary', bytes: new Uint8Array(0) })?.onShare
    ).toBeTypeOf('function');
    expect(
      actions.buildErrorActions('package.deb', { kind: 'binary', bytes: Uint8Array.of(1) })?.onShare
    ).toBeTypeOf('function');
    expect(actions.buildErrorActions('large.deb')?.onCopyPath).toBeTypeOf('function');
  });

  it.each([false, true])(
    'preserves browser concurrency and only locks native exports (native=%s)',
    async (native) => {
      nativeShell = native;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let actions!: SessionFileActions;
      const fileProvider = {
        openFile: async (path: string): Promise<FileWorkspaceOpenResult> => {
          await ready;
          return {
            status: 'ready',
            entry: { entryType: 'file', path },
            snapshot: { kind: 'binary', bytes: Uint8Array.of(path === 'a.deb' ? 1 : 2) },
          } as FileWorkspaceOpenResult;
        },
      };
      function Probe() {
        actions = useSessionFileActions({ session, fileProvider });
        return null;
      }
      await act(async () => {
        root?.render(createElement(Provider, null, createElement(Probe)));
      });
      await act(async () => {
        actions.download?.('a.deb');
        actions.download?.('b.deb');
      });
      await act(async () => {
        release();
      });
      if (native) {
        expect(sharedBytes).toEqual(Uint8Array.of(1));
        expect(downloadBytesAsFile.mock.calls).toEqual([]);
        await act(async () => {
          actions.download?.('b.deb');
        });
        expect(sharedBytes).toEqual(Uint8Array.of(2));
      } else {
        expect(downloadBytesAsFile.mock.calls).toEqual([
          ['a.deb', Uint8Array.of(1)],
          ['b.deb', Uint8Array.of(2)],
        ]);
        expect(sharedBytes).toBeUndefined();
      }
    }
  );

  it('downloads the bytes of a file the preview API can return', async () => {
    await runDownload({
      status: 'ready',
      entry: { entryType: 'file', fileId: 'docs/huge.log', path: 'docs/huge.log' },
      snapshot: { kind: 'text', text: 'hello' },
    } as unknown as FileWorkspaceOpenResult);

    expect(downloadBytesAsFile).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('exports the complete binary snapshot in the native shell', async () => {
    nativeShell = true;
    const bytes = Uint8Array.of(0, 255, 7);
    await runDownload({
      status: 'ready',
      entry: { entryType: 'file', fileId: 'package.deb', path: 'package.deb' },
      snapshot: { kind: 'binary', bytes },
    } as unknown as FileWorkspaceOpenResult);
    expect(sharedBytes).toEqual(bytes);
    expect(downloadBytesAsFile).not.toHaveBeenCalled();
    nativeShell = false;
  });

  it('names the real ceiling when the file is past what one response carries', async () => {
    await runDownload({ status: 'unavailable', reason: 'text-too-large' });

    expect(downloadBytesAsFile).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'This file is too large to download from here. Open it on the machine that owns it.'
    );
  });

  it('treats a binary snapshot with no bytes as the same ceiling', async () => {
    // The machine declined to send the bytes, which is that same situation.
    await runDownload({
      status: 'ready',
      entry: { entryType: 'file', fileId: 'assets/clip.mov', path: 'assets/clip.mov' },
      snapshot: { kind: 'binary' },
    } as unknown as FileWorkspaceOpenResult);

    expect(downloadBytesAsFile).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'This file is too large to download from here. Open it on the machine that owns it.'
    );
  });
});

describe('local-host actions vs a resolvable host path', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    bridgeAvailable = true;
    toastError.mockClear();
    toastSuccess.mockClear();
    revealLocalPath.mockClear();
    openLocalPath.mockClear();
    launchLocalPath.mockClear();
    probePathLaunchers.mockClear();
    writeTextToClipboard.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localMachineId = session.machineId;
    localHomeDir = '/home/dev';
    (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    (window as { __LODY_PLATFORM__?: { os: string } }).__LODY_PLATFORM__ = { os: 'darwin' };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    delete (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
    delete (window as { __LODY_PLATFORM__?: { os: string } }).__LODY_PLATFORM__;
    localMachineId = null;
    localHomeDir = '/home/dev';
    vi.restoreAllMocks();
  });

  const resolveActions = async (): Promise<SessionFileActions> => {
    const fileProvider = {
      openFile: async () => ({ status: 'unavailable' as const, reason: 'deleted' as const }),
    };
    let actions: SessionFileActions | undefined;
    function Probe() {
      actions = useSessionFileActions({ session, fileProvider });
      return null;
    }
    await act(async () => {
      root?.render(createElement(Provider, null, createElement(Probe)));
    });
    await act(async () => {
      await Promise.resolve();
    });
    if (!actions) throw new Error('hook did not render');
    return actions;
  };

  it('offers the shell actions once the machine path resolves', async () => {
    const actions = await resolveActions();

    expect(actions.resolveHostPath('src/main.ts')).not.toBeNull();
    expect(actions.localHost).not.toBeNull();
    expect(actions.menuItems.map((item) => item.id)).toEqual([
      'copy-relative-path',
      'copy-absolute-path',
      'open-in-editor',
      'reveal',
    ]);
    // The download is the complement, so it stays away while the shell is reachable.
    expect(actions.download).toBeNull();
  });

  it('splits Copy into the relative path and the resolved absolute path', async () => {
    const actions = await resolveActions();
    const relative = 'src/main.ts';
    const absolute = actions.resolveHostPath(relative);
    expect(absolute).not.toBeNull();

    await act(async () => {
      actions.menuItems.find((item) => item.id === 'copy-relative-path')?.run(relative);
      await Promise.resolve();
    });
    expect(writeTextToClipboard).toHaveBeenLastCalledWith(relative);

    await act(async () => {
      actions.menuItems.find((item) => item.id === 'copy-absolute-path')?.run(relative);
      await Promise.resolve();
    });
    expect(writeTextToClipboard).toHaveBeenLastCalledWith(absolute);
    expect(toastSuccess).toHaveBeenLastCalledWith('File path copied');
  });

  it('reveals an absolute local artifact through both the menu and preview action', async () => {
    const actions = await resolveActions();
    const artifact = '/tmp/build/Lody.zip';
    await act(async () => {
      actions.menuItems.find((item) => item.id === 'reveal')?.run(artifact);
    });
    expect(revealLocalPath).toHaveBeenLastCalledWith(artifact);
    await act(async () => {
      actions.buildErrorActions(artifact)?.localHost?.onOpen();
    });
    expect(openLocalPath).toHaveBeenLastCalledWith(artifact);
  });

  it('expands a home-rooted Markdown link against the local home directory', async () => {
    const actions = await resolveActions();
    const homeRooted = '~/Code/my-spells/better-readme/SKILL.md';
    const expanded = '/home/dev/Code/my-spells/better-readme/SKILL.md';
    expect(actions.resolveHostPath(homeRooted)).toBe(expanded);

    const items = actions.buildMarkdownLinkMenuItems(homeRooted);
    const reveal = items.find((item) => item.id === 'reveal');
    if (!reveal || reveal.kind !== 'action') throw new Error('Missing reveal action');
    await act(async () => {
      reveal.run();
      await Promise.resolve();
    });
    expect(revealLocalPath).toHaveBeenLastCalledWith(expanded);
  });

  it('never resolves a home-rooted path against a remote workspace', async () => {
    localMachineId = 'another-machine';
    const actions = await resolveActions();
    expect(actions.resolveHostPath('~/Code/app/SKILL.md')).toBeNull();

    const items = actions.buildMarkdownLinkMenuItems('~/Code/app/SKILL.md');
    expect(items.map((item) => item.id)).toEqual(['copy-path']);
    await act(async () => {
      const item = items[0];
      if (item?.kind === 'action') item.run();
      await Promise.resolve();
    });
    expect(writeTextToClipboard).toHaveBeenLastCalledWith('~/Code/app/SKILL.md');
    expect(openLocalPath).not.toHaveBeenCalled();
    expect(revealLocalPath).not.toHaveBeenCalled();
  });

  it.each(['/tmp/build/Lody.zip', '/tmp/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/Lody.zip'])(
    'keeps the local Markdown-link target and removes line anchors: %s',
    async (artifact) => {
      const actions = await resolveActions();
      const items = actions.buildMarkdownLinkMenuItems(`${artifact}:366`);
      expect(items.map((item) => item.id)).toEqual([
        'copy-path',
        'open-file',
        'open-in-editor',
        'open-with',
        'reveal',
      ]);

      const action = (id: string) => {
        const item = items.find((candidate) => candidate.id === id);
        if (!item || item.kind !== 'action') throw new Error(`Missing action: ${id}`);
        return item;
      };
      await act(async () => {
        action('copy-path').run();
        action('open-file').run();
        action('open-in-editor').run();
        await Promise.resolve();
      });
      expect(writeTextToClipboard).toHaveBeenLastCalledWith(artifact);
      expect(openLocalPath).toHaveBeenLastCalledWith(artifact);
      expect(launchLocalPath).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetPath: artifact })
      );

      const openWith = items.find((item) => item.id === 'open-with');
      if (!openWith || openWith.kind !== 'submenu') throw new Error('Missing Open with submenu');
      expect(openWith.items.length).toBeGreaterThan(0);
      await act(async () => {
        openWith.items[0]?.run();
        action('reveal').run();
        await Promise.resolve();
      });
      expect(launchLocalPath).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetPath: artifact })
      );
      expect(revealLocalPath).toHaveBeenLastCalledWith(artifact);
    }
  );

  it('does not offer local shell actions for an absolute remote path', async () => {
    localMachineId = 'another-machine';
    const actions = await resolveActions();
    expect(actions.buildErrorActions('/tmp/build/Lody.zip')?.localHost).toBeUndefined();
    expect(actions.menuItems.some((item) => item.id === 'reveal')).toBe(false);
  });

  it('offers only Copy file path for Markdown links outside the local Electron boundary', async () => {
    localMachineId = 'another-machine';
    const actions = await resolveActions();
    const items = actions.buildMarkdownLinkMenuItems('/tmp/build/Lody.zip:366');
    expect(items.map((item) => item.id)).toEqual(['copy-path']);
    await act(async () => {
      const item = items[0];
      if (item?.kind === 'action') item.run();
      await Promise.resolve();
    });
    expect(writeTextToClipboard).toHaveBeenLastCalledWith('/tmp/build/Lody.zip');
    expect(openLocalPath).not.toHaveBeenCalled();
    expect(revealLocalPath).not.toHaveBeenCalled();
    expect(launchLocalPath).not.toHaveBeenCalled();
  });

  it('reports a reveal IPC failure without claiming an application is missing', async () => {
    revealLocalPath.mockRejectedValueOnce(new Error('IPC unavailable'));
    const actions = await resolveActions();
    await act(async () => {
      actions.localHost?.reveal('/tmp/build/Lody.zip');
    });
    expect(toastError).toHaveBeenLastCalledWith(
      'Could not reveal that file.',
      expect.objectContaining({
        description: expect.any(String),
        action: expect.objectContaining({ label: 'Copy error details' }),
      })
    );
    expect(console.error).toHaveBeenLastCalledWith(
      '[session-file-actions] Local file action failed',
      expect.objectContaining({
        action: 'reveal',
        filePath: '/tmp/build/Lody.zip',
        resolvedPath: '/tmp/build/Lody.zip',
        error: 'IPC unavailable',
      }),
      expect.any(Error)
    );
  });

  it('passes a local parent-relative DMG to Finder and the selected editor', async () => {
    const actions = await resolveActions();
    const filePath = '../artifacts/Lody.dmg';
    const hostPath = actions.resolveHostPath(filePath);
    expect(hostPath).toMatch(/\/\.\.\/artifacts\/Lody\.dmg$/);
    await act(async () => {
      actions.localHost?.reveal(filePath);
      actions.localHost?.editor?.open(filePath);
    });
    expect(revealLocalPath).toHaveBeenLastCalledWith(hostPath);
    expect(launchLocalPath).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetPath: hostPath })
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('shows and copies the failed path resolution without attempting IPC', async () => {
    const actions = await resolveActions();
    actions.localHost?.reveal('');
    expect(revealLocalPath).not.toHaveBeenCalled();
    const options = toastError.mock.calls.at(-1)?.[1] as {
      description: string;
      action: { onClick: () => void };
    };
    expect(options.description).toContain('file path could not be resolved');
    await act(async () => options.action.onClick());
    expect(JSON.parse(writeTextToClipboard.mock.calls.at(-1)![0])).toMatchObject({
      action: 'reveal',
      filePath: '',
      resolvedPath: null,
      error: 'path_unresolved',
      machineId: session.machineId,
    });
  });

  it('reports a missing bridge for editor actions instead of silently returning', async () => {
    bridgeAvailable = false;
    const actions = await resolveActions();
    await act(async () => actions.localHost?.editor?.open('/tmp/Lody.dmg'));
    expect(toastError).toHaveBeenLastCalledWith(
      'Failed to open path',
      expect.objectContaining({
        description: 'The desktop connection is unavailable. Restart Lody and try again.',
      })
    );
  });

  it('retains editor launch errors and provides editor-specific guidance', async () => {
    launchLocalPath.mockResolvedValueOnce({
      launched: false,
      command: 'code',
      error: 'spawn code ENOENT',
    });
    const actions = await resolveActions();
    await act(async () => actions.localHost?.editor?.open('/tmp/Lody.dmg'));
    expect(console.error).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'editor',
        error: 'spawn code ENOENT',
        result: { launched: false, command: 'code', error: 'spawn code ENOENT' },
      }),
      expect.anything()
    );
    expect(toastError).toHaveBeenLastCalledWith(
      'Failed to open path',
      expect.objectContaining({
        description: expect.stringContaining('selected editor is installed'),
      })
    );
  });

  it('distinguishes file access denial from a missing file', async () => {
    revealLocalPath.mockResolvedValueOnce({ revealed: false, error: 'EPERM' });
    const actions = await resolveActions();
    await act(async () => actions.localHost?.reveal('/tmp/Lody.dmg'));
    expect(toastError).toHaveBeenLastCalledWith(
      'Could not reveal that file.',
      expect.objectContaining({ description: expect.stringContaining('file permissions') })
    );
  });

  it('offers no shell action, and keeps the download, while the path is unresolved', async () => {
    // Same machine, same desktop app — the path metadata simply has not landed.
    localHomeDir = null;
    const actions = await resolveActions();

    expect(actions.resolveHostPath('src/main.ts')).toBeNull();
    expect(actions.localHost).toBeNull();
    // The menu renderers hide items whose `isAvailable` predicate declines the
    // path, so filter the same way to read the offered actions.
    const visibleIds = actions.menuItems
      .filter((item) => item.isAvailable?.('src/main.ts') ?? true)
      .map((item) => item.id);
    expect(visibleIds).toEqual(['copy-relative-path', 'download']);
    expect(actions.download).not.toBeNull();
  });

  it('keeps the absolute copy, and drops the relative one, for an absolute path', async () => {
    localMachineId = 'another-machine';
    const actions = await resolveActions();
    const artifact = '/tmp/build/Lody.zip';

    const relativeItem = actions.menuItems.find((item) => item.id === 'copy-relative-path');
    expect(relativeItem?.isAvailable?.(artifact)).toBe(false);
    await act(async () => {
      actions.menuItems.find((item) => item.id === 'copy-absolute-path')?.run(artifact);
      await Promise.resolve();
    });
    expect(writeTextToClipboard).toHaveBeenLastCalledWith(artifact);
  });
});

describe('ranged remote download (file/read-range)', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const FILE = 'renders/flyover.mp4';
  const BYTES = Uint8Array.from({ length: 10 }, (_, index) => 250 - index);

  beforeEach(async () => {
    await initI18n('en');
    toastError.mockClear();
    toastShow.mockClear();
    toastDismiss.mockClear();
    downloadBytesAsFile.mockClear();
    downloadPartsAsFile.mockClear();
    nativeShell = false;
    localMachineId = null;
    localHomeDir = '/home/dev';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    rangeRuntime = null;
    delete (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
  });

  /** A machine serving `bytes` four at a time, the way `file/read-range` clamps. */
  const serveRanges = (bytes: Uint8Array) =>
    vi.fn(
      async (
        _machineId: string,
        request: Omit<FileReadRangeRequest, 'v'>
      ): Promise<FileReadRangeResponse> => {
        const chunk = bytes.subarray(request.offset, request.offset + Math.min(4, request.length));
        return {
          status: 'ok',
          v: 1,
          path: request.path,
          revision: 'rev-1',
          sizeBytes: bytes.byteLength,
          offset: request.offset,
          data: Buffer.from(chunk).toString('base64'),
          rawBytes: chunk.byteLength,
        };
      }
    );

  const mount = async ({
    servesRanges = true,
    openFile = vi.fn(),
  }: { servesRanges?: boolean; openFile?: () => Promise<FileWorkspaceOpenResult> } = {}) => {
    const store = createStore();
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(session.machineId as MachineId)]: {
        id: session.machineId,
        protocolCapabilities: servesRanges ? { fileReadRange: 1 } : {},
      } as unknown as MachineMeta,
    });
    const current: { actions?: SessionFileActions } = {};
    const fileProvider = { openFile };
    function Probe() {
      current.actions = useSessionFileActions({ session, fileProvider });
      return null;
    }
    await act(async () => {
      root?.render(createElement(Provider, { store }, createElement(Probe)));
    });
    const actions = () => {
      if (!current.actions) throw new Error('hook did not render');
      return current.actions;
    };
    return { actions, openFile };
  };

  it('downloads the whole file in ranges of one revision, never through the preview read', async () => {
    const requestFileReadRange = serveRanges(BYTES);
    rangeRuntime = { requestFileReadRange };
    const { actions, openFile } = await mount();

    await act(async () => {
      actions().download?.(FILE);
    });
    await vi.waitFor(() => expect(downloadPartsAsFile).toHaveBeenCalledTimes(1));

    const [savedPath, parts] = downloadPartsAsFile.mock.calls[0] as [string, Uint8Array[]];
    expect(savedPath).toBe(FILE);
    expect(Uint8Array.from(parts.flatMap((part) => [...part]))).toEqual(BYTES);
    expect(openFile).not.toHaveBeenCalled();
    expect(
      requestFileReadRange.mock.calls.map(([machineId, request, options]) => [
        machineId,
        request.offset,
        request.revision,
        options?.ownerSessionId,
      ])
    ).toEqual([
      ['machine-remote', 0, undefined, 'session-download'],
      ['machine-remote', 4, 'rev-1', 'session-download'],
      ['machine-remote', 8, 'rev-1', 'session-download'],
    ]);
    // Progress is visible while it runs and gone once the browser has the file.
    expect(toastShow).toHaveBeenLastCalledWith(
      `Downloading ${FILE}…`,
      expect.objectContaining({ description: '10 B / 10 B' })
    );
    expect(toastDismiss).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('offers Download beside Copy file path on the card and the Markdown menu', async () => {
    rangeRuntime = { requestFileReadRange: serveRanges(BYTES) };
    const { actions } = await mount();

    expect(actions().buildErrorActions(FILE)?.onDownload).toBeTypeOf('function');
    const items = actions().buildMarkdownLinkMenuItems(FILE);
    expect(items.map((item) => [item.id, item.label])).toEqual([
      ['copy-path', 'Copy file path'],
      ['download', 'Download file'],
    ]);
  });

  it('keeps Download off the card and the Markdown menu when the machine cannot serve ranges', async () => {
    rangeRuntime = { requestFileReadRange: serveRanges(BYTES) };
    const { actions } = await mount({ servesRanges: false });

    // The preview-read fallback would fail for exactly the files the card shows.
    expect(actions().buildErrorActions(FILE)?.onDownload).toBeUndefined();
    expect(
      actions()
        .buildMarkdownLinkMenuItems(FILE)
        .map((item) => item.id)
    ).toEqual(['copy-path']);
  });

  it('never sends a same-machine Electron path over the Streams plane', async () => {
    (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    localMachineId = session.machineId;
    // The host path has not resolved, so the shell actions are not offered yet.
    localHomeDir = null;
    const requestFileReadRange = serveRanges(BYTES);
    rangeRuntime = { requestFileReadRange };
    const { actions } = await mount();

    expect(actions().buildErrorActions(FILE)?.onDownload).toBeUndefined();
    expect(
      actions()
        .buildMarkdownLinkMenuItems(FILE)
        .map((item) => item.id)
    ).toEqual(['copy-path']);
    expect(requestFileReadRange).not.toHaveBeenCalled();
  });

  it('refuses to stitch a file that changed between ranges', async () => {
    const served = serveRanges(BYTES);
    rangeRuntime = {
      requestFileReadRange: async (machineId, request, options) =>
        request.offset === 0
          ? await served(machineId, request, options)
          : { status: 'error', v: 1, code: 'file_changed' },
    };
    const { actions } = await mount();

    await act(async () => {
      actions().buildErrorActions(FILE)?.onDownload?.();
    });
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'The file changed while it was downloading. Try again.'
      )
    );
    expect(downloadPartsAsFile).not.toHaveBeenCalled();
  });

  it('cancels from the progress toast without saving a partial file', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = serveRanges(BYTES);
    rangeRuntime = {
      requestFileReadRange: async (machineId, request, options) => {
        await held;
        return await served(machineId, request, options);
      },
    };
    const { actions } = await mount();

    await act(async () => {
      actions().buildErrorActions(FILE)?.onDownload?.();
    });
    expect(actions().buildErrorActions(FILE)?.downloading).toBe(true);
    const progress = toastShow.mock.calls.at(-1)?.[1] as {
      id: string;
      action: { label: string; onClick: () => void };
    };
    expect(progress.action.label).toBe('Cancel');

    await act(async () => {
      progress.action.onClick();
      release();
    });
    await vi.waitFor(() => expect(actions().buildErrorActions(FILE)?.downloading).toBe(false));
    expect(toastDismiss).toHaveBeenCalledWith(progress.id);
    expect(downloadPartsAsFile).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

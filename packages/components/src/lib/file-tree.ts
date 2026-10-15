import type { FileTreeItem } from '@lody/shared';

type DirNode = {
  type: 'directory';
  name: string;
  path: string;
  children: Map<string, Node>;
};

type FileNode = {
  type: 'file';
  name: string;
  path: string;
  modified: boolean;
};

type Node = DirNode | FileNode;

const nodeToFileTreeItem = (node: Node): FileTreeItem => {
  if (node.type === 'file') {
    return { path: node.path, type: 'file', modified: node.modified };
  }

  const children = Array.from(node.children.values())
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map(nodeToFileTreeItem);

  const hasModifiedChildren = children.some((child) => child.modified);

  return { path: node.path, type: 'directory', children, modified: hasModifiedChildren };
};

/**
 * Re-derive the `modified` highlight on an already-built tree from an explicit
 * set of changed file paths (the "Changes list").
 *
 * Why a separate pass instead of `buildFileTreeFromPaths(..., modifiedPaths)`:
 * the live Code Collab metadata snapshot strips per-file `modifiedTime` (it only
 * publishes path + a materialized-text flag), so provider entries can never carry
 * `modified` in production live mode. The authoritative source for "which files
 * changed" is the diff summary that also feeds the Changes sidebar, which arrives
 * independently of (and after) the file tree. This lets the file-tree highlight
 * stay in lockstep with the Changes list regardless of the tree's own source.
 */
export function markFileTreeModified(
  items: readonly FileTreeItem[],
  modifiedPaths: ReadonlySet<string>
): FileTreeItem[] {
  const mark = (item: FileTreeItem): FileTreeItem => {
    if (item.type === 'file') {
      return { ...item, modified: modifiedPaths.has(item.path) };
    }
    const children = (item.children ?? []).map(mark);
    return { ...item, children, modified: children.some((child) => child.modified) };
  };
  return items.map(mark);
}

export function buildFileTreeFromPaths(
  paths: readonly string[],
  modifiedPaths: ReadonlySet<string> = new Set<string>()
): FileTreeItem[] {
  const root: DirNode = {
    type: 'directory',
    name: '',
    path: '',
    children: new Map(),
  };

  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) {
      continue;
    }

    const leadingSlash = trimmed.startsWith('/') ? '/' : '';
    const segments = trimmed.split('/').filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }

      const isLast = index === segments.length - 1;
      const currentPath = `${leadingSlash}${segments.slice(0, index + 1).join('/')}`;

      if (isLast) {
        const existing = current.children.get(segment);
        if (existing?.type === 'directory') {
          continue;
        }
        current.children.set(segment, {
          type: 'file',
          name: segment,
          path: currentPath,
          modified: modifiedPaths.has(currentPath),
        });
        continue;
      }

      const existing = current.children.get(segment);
      if (existing?.type === 'directory') {
        current = existing;
        continue;
      }

      const nextDirectory: DirNode = {
        type: 'directory',
        name: segment,
        path: currentPath,
        children: new Map(),
      };
      current.children.set(segment, nextDirectory);
      current = nextDirectory;
    }
  }

  return Array.from(root.children.values())
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map(nodeToFileTreeItem);
}

/** The part of a provider entry the ignored-name overlay reads. */
export type IgnoredFileTreeEntry = {
  readonly path: string;
  readonly entryType?: 'file' | 'lazy-directory';
};

const NO_IGNORED_PATHS: ReadonlySet<string> = new Set<string>();

const compareFileTreeSiblings = (left: FileTreeItem, right: FileTreeItem): number => {
  if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
  return left.path.localeCompare(right.path);
};

const parentWorkspacePath = (path: string): string => {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '' : path.slice(0, separator);
};

const workspacePathDepth = (path: string): number => (path ? path.split('/').length : 0);

/**
 * Overlay per-viewer ignored-name listings on the shared index tree.
 *
 * `listings` maps a directory (`''` = root) to the entries the machine listed for
 * it. The root listing may reach any depth; a directory's own listing is adopted
 * only when an earlier listing added that directory as an ignored lazy one, so a
 * listing left over from before the directory vanished or became indexed is
 * dropped. Indexed paths always win, and missing parents are synthesized as
 * ignored. The input tree is never mutated, and with no listings it is returned
 * by reference so the default (hidden) path costs nothing.
 */
export function mergeIgnoredFileTreeEntries(
  tree: FileTreeItem[],
  listings: ReadonlyMap<string, readonly IgnoredFileTreeEntry[]>
): { readonly tree: FileTreeItem[]; readonly ignoredPaths: ReadonlySet<string> } {
  if (listings.size === 0) return { tree, ignoredPaths: NO_IGNORED_PATHS };

  const itemsByPath = new Map<string, FileTreeItem>();
  const clone = (item: FileTreeItem): FileTreeItem => {
    const copy: FileTreeItem =
      item.children === undefined ? { ...item } : { ...item, children: item.children.map(clone) };
    itemsByPath.set(copy.path, copy);
    return copy;
  };
  const merged = tree.map(clone);
  const ignoredPaths = new Set<string>();
  const ignoredLazyDirectories = new Set<string>();
  const unsortedSiblings = new Set<FileTreeItem[]>();

  const childrenOf = (directoryPath: string): FileTreeItem[] | null => {
    if (!directoryPath) return merged;
    const existing = itemsByPath.get(directoryPath);
    if (existing) return existing.type === 'directory' ? (existing.children ??= []) : null;
    const siblings = childrenOf(parentWorkspacePath(directoryPath));
    if (!siblings) return null;
    const children: FileTreeItem[] = [];
    const directory: FileTreeItem = { path: directoryPath, type: 'directory', children };
    siblings.push(directory);
    unsortedSiblings.add(siblings);
    itemsByPath.set(directoryPath, directory);
    ignoredPaths.add(directoryPath);
    return children;
  };

  const ordered = [...listings].sort(
    ([left], [right]) =>
      workspacePathDepth(left) - workspacePathDepth(right) || left.localeCompare(right)
  );
  for (const [directoryPath, entries] of ordered) {
    if (directoryPath && !ignoredLazyDirectories.has(directoryPath)) continue;
    for (const entry of entries) {
      if (itemsByPath.has(entry.path)) continue;
      const siblings = childrenOf(parentWorkspacePath(entry.path));
      if (!siblings) continue;
      const item: FileTreeItem =
        entry.entryType === 'lazy-directory'
          ? { path: entry.path, type: 'directory', children: [], lazyDirectoryId: entry.path }
          : { path: entry.path, type: 'file' };
      if (item.lazyDirectoryId !== undefined) ignoredLazyDirectories.add(entry.path);
      siblings.push(item);
      unsortedSiblings.add(siblings);
      itemsByPath.set(entry.path, item);
      ignoredPaths.add(entry.path);
    }
  }
  for (const siblings of unsortedSiblings) siblings.sort(compareFileTreeSiblings);
  return { tree: merged, ignoredPaths };
}

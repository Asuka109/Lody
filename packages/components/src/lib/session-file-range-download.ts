import {
  FILE_READ_RANGE_LIMITS,
  type FileReadRangeErrorCode,
  type FileReadRangeRequest,
  type FileReadRangeResponse,
} from '@lody/shared';
import { base64ToBytes } from './base64';

/** One `file/read-range` call, already bound to its machine and session. */
export type SessionFileRangeReader = (
  request: Omit<FileReadRangeRequest, 'v' | 'sessionId'>
) => Promise<FileReadRangeResponse>;

export type SessionFileRangeDownloadProgress = {
  readonly receivedBytes: number;
  readonly totalBytes: number;
};

export type SessionFileRangeDownloadResult =
  | {
      readonly status: 'ok';
      /** The path the machine actually read. */
      readonly path: string;
      readonly sizeBytes: number;
      readonly parts: readonly Uint8Array[];
    }
  | {
      readonly status: 'error';
      /** `invalid_response`: the machine answered something that cannot be stitched. */
      readonly code: FileReadRangeErrorCode | 'invalid_response';
      readonly message?: string;
    }
  | { readonly status: 'aborted' };

/**
 * Download a whole file through bounded `file/read-range` calls, in order.
 *
 * The first chunk's revision is sent back with every later request, and every
 * chunk must agree on revision, size and offset: a download is either one
 * version of the file or an error, never a splice of two. Ranges are requested
 * one at a time so a download holds one Machine RPC slot, not the machine's
 * whole request budget. A failed range fails the download; there is no retry
 * loop here, so a user-visible error is the only outcome of a transport fault.
 */
export async function downloadSessionFileInRanges({
  path,
  readRange,
  signal,
  onProgress,
  chunkBytes = FILE_READ_RANGE_LIMITS.maxChunkBytes,
}: {
  readonly path: string;
  readonly readRange: SessionFileRangeReader;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SessionFileRangeDownloadProgress) => void;
  readonly chunkBytes?: number;
}): Promise<SessionFileRangeDownloadResult> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let revision: string | undefined;
  let sizeBytes: number | undefined;

  for (;;) {
    if (signal?.aborted) return { status: 'aborted' };
    const response = await readRange({
      path,
      offset,
      length: chunkBytes,
      ...(revision === undefined ? {} : { revision }),
    });
    if (signal?.aborted) return { status: 'aborted' };
    if (response.status === 'error') {
      return {
        status: 'error',
        code: response.code,
        ...(response.message === undefined ? {} : { message: response.message }),
      };
    }
    if (
      response.offset !== offset ||
      (revision !== undefined && response.revision !== revision) ||
      (sizeBytes !== undefined && response.sizeBytes !== sizeBytes)
    ) {
      return { status: 'error', code: 'invalid_response', message: 'Range does not match.' };
    }
    const bytes = base64ToBytes(response.data);
    const remaining = response.sizeBytes - offset;
    // An empty range before the end would loop forever; an oversized one
    // would make the assembled file longer than the file it claims to be.
    if (
      bytes.byteLength !== response.rawBytes ||
      bytes.byteLength > remaining ||
      (bytes.byteLength === 0 && remaining > 0)
    ) {
      return { status: 'error', code: 'invalid_response', message: 'Range size is invalid.' };
    }

    revision = response.revision;
    sizeBytes = response.sizeBytes;
    if (bytes.byteLength > 0) parts.push(bytes);
    offset += bytes.byteLength;
    onProgress?.({ receivedBytes: offset, totalBytes: sizeBytes });
    if (offset === sizeBytes) {
      return { status: 'ok', path: response.path, sizeBytes, parts };
    }
  }
}

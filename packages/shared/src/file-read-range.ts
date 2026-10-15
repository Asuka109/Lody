import { z } from 'zod';

/**
 * File Read Range v1 — the machine-side "give me these bytes of this file"
 * protocol behind downloading a session file that File Preview v3 refuses.
 *
 * Why a second method next to `file/preview`: a preview is ONE bounded response
 * (see `FILE_PREVIEW_V3_LIMITS`), and a remote oversize file is refused rather
 * than truncated. Raising that budget is not an option — a single Machine RPC
 * response has a gateway ceiling that is not asserted in this repository. A
 * download therefore asks for the file in bounded ranges and the client
 * reassembles them. Like a preview, a range read is a plain read: it must never
 * activate Code Collab, and it serves exactly the paths a remote preview may
 * serve (the same path policy, never the local-only arbitrary-path mode).
 *
 * Every chunk carries the file's `revision`. The client sends the first one
 * back on every later request, and the machine answers `file_changed` once the
 * file is replaced or rewritten, so a download is never stitched together from
 * two versions of the file.
 *
 * Machines advertise this method through the `fileReadRange` protocol
 * capability; clients never send it to a machine that does not.
 */
export const FILE_READ_RANGE_PROTOCOL_VERSION = 1;

export const FILE_READ_RANGE_LIMITS = {
  /**
   * Raw bytes per response. Base64 and the owner-session envelope inflate it,
   * so it stays below the 5 MiB binary preview budget that is already proven
   * for exactly this payload shape (base64 bytes in one Machine RPC response).
   */
  maxChunkBytes: 4 * 1024 * 1024,
  /**
   * Whole-file ceiling for one download. Every chunk travels through the hosted
   * Streams plane and the client holds the assembled file in memory until it is
   * saved, so the budget is bounded on both ends.
   */
  maxFileBytes: 256 * 1024 * 1024,
} as const;
export type FileReadRangeLimits = typeof FILE_READ_RANGE_LIMITS;

export const FileReadRangeRequestSchema = z
  .object({
    v: z.literal(FILE_READ_RANGE_PROTOCOL_VERSION),
    sessionId: z.string().trim().min(1),
    /** Workspace-relative, or absolute inside a remote preview's allowed roots. */
    path: z.string().min(1),
    offset: z.number().int().nonnegative(),
    /** Requested byte count; the machine clamps it to `maxChunkBytes`. */
    length: z.number().int().positive(),
    /** The revision from the first chunk. Omitted only on the first request. */
    revision: z.string().min(1).max(256).optional(),
  })
  .strict();
export type FileReadRangeRequest = z.infer<typeof FileReadRangeRequestSchema>;

export const FileReadRangeOkSchema = z
  .object({
    status: z.literal('ok'),
    v: z.literal(FILE_READ_RANGE_PROTOCOL_VERSION),
    /**
     * Workspace-relative when the file lives in the session workspace, otherwise
     * the absolute path the machine actually read.
     */
    path: z.string().min(1),
    external: z.boolean().optional(),
    /** Opaque file identity + version. Echo it on every later range request. */
    revision: z.string().min(1).max(256),
    /** Size of the whole file at `revision`. */
    sizeBytes: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    /** Base64 of the bytes read; fewer than requested only at the end of the file. */
    data: z.string(),
    rawBytes: z.number().int().nonnegative(),
  })
  .strict();
export type FileReadRangeOk = z.infer<typeof FileReadRangeOkSchema>;

export const FileReadRangeErrorCodeSchema = z.enum([
  'invalid_path',
  /** Resolved outside every allowed root — the security boundary, not an IO failure. */
  'path_not_allowed',
  'session_not_found',
  'workspace_root_unavailable',
  'machine_offline',
  'file_not_found',
  'not_a_file',
  'permission_denied',
  /** The whole file exceeds `maxFileBytes`. */
  'too_large',
  /** `offset` is past the end of the file. */
  'invalid_range',
  /** The file no longer matches the requested `revision`. */
  'file_changed',
  'transient_io',
]);
export type FileReadRangeErrorCode = z.infer<typeof FileReadRangeErrorCodeSchema>;

export const FileReadRangeErrorSchema = z
  .object({
    status: z.literal('error'),
    v: z.literal(FILE_READ_RANGE_PROTOCOL_VERSION),
    code: FileReadRangeErrorCodeSchema,
    message: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    /** Set with `too_large` so the UI can state the real numbers. */
    sizeBytes: z.number().int().nonnegative().optional(),
    limitBytes: z.number().int().nonnegative().optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type FileReadRangeError = z.infer<typeof FileReadRangeErrorSchema>;

export const FileReadRangeResponseSchema = z.discriminatedUnion('status', [
  FileReadRangeOkSchema,
  FileReadRangeErrorSchema,
]);
export type FileReadRangeResponse = z.infer<typeof FileReadRangeResponseSchema>;

export function fileReadRangeError(
  code: FileReadRangeErrorCode,
  options: {
    readonly message?: string;
    readonly path?: string;
    readonly sizeBytes?: number;
    readonly limitBytes?: number;
    readonly retryable?: boolean;
  } = {}
): FileReadRangeError {
  return {
    status: 'error',
    v: FILE_READ_RANGE_PROTOCOL_VERSION,
    code,
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }),
    ...(options.limitBytes === undefined ? {} : { limitBytes: options.limitBytes }),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  };
}

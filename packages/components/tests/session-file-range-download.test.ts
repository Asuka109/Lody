import { describe, expect, it } from 'vitest';
import type { FileReadRangeOk, FileReadRangeResponse } from '@lody/shared';
import {
  downloadSessionFileInRanges,
  type SessionFileRangeReader,
} from '../src/lib/session-file-range-download';

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function rangeOk(
  bytes: Uint8Array,
  offset: number,
  overrides: Partial<FileReadRangeOk> = {}
): FileReadRangeResponse {
  const chunk = bytes.subarray(offset, offset + 3);
  return {
    status: 'ok',
    v: 1,
    path: 'out/build.zip',
    revision: 'rev-1',
    sizeBytes: bytes.byteLength,
    offset,
    data: encode(chunk),
    rawBytes: chunk.byteLength,
    ...overrides,
  };
}

const BYTES = Uint8Array.of(9, 8, 7, 6, 5, 4, 3);

describe('downloadSessionFileInRanges', () => {
  it('never splices two revisions of the file into one download', async () => {
    const readRange: SessionFileRangeReader = async ({ offset }) =>
      rangeOk(BYTES, offset, offset === 0 ? {} : { revision: 'rev-2' });

    const result = await downloadSessionFileInRanges({ path: 'out/build.zip', readRange });

    expect(result).toMatchObject({ status: 'error', code: 'invalid_response' });
  });

  it('fails instead of looping forever on an empty range before the end', async () => {
    let calls = 0;
    const readRange: SessionFileRangeReader = async ({ offset }) => {
      calls += 1;
      return { ...rangeOk(BYTES, offset), data: '', rawBytes: 0 };
    };

    const result = await downloadSessionFileInRanges({ path: 'out/build.zip', readRange });

    expect(result).toMatchObject({ status: 'error', code: 'invalid_response' });
    expect(calls).toBe(1);
  });

  it('rejects a range whose bytes would overrun the file it describes', async () => {
    const readRange: SessionFileRangeReader = async ({ offset }) => ({
      ...rangeOk(BYTES, offset),
      sizeBytes: 2,
    });

    const result = await downloadSessionFileInRanges({ path: 'out/build.zip', readRange });

    expect(result).toMatchObject({ status: 'error', code: 'invalid_response' });
  });

  it('completes an empty file with a single range and no parts', async () => {
    const empty = new Uint8Array(0);
    const result = await downloadSessionFileInRanges({
      path: 'out/empty.log',
      readRange: async ({ offset }) => rangeOk(empty, offset, { path: 'out/empty.log' }),
    });

    expect(result).toEqual({ status: 'ok', path: 'out/empty.log', sizeBytes: 0, parts: [] });
  });

  it('passes a machine refusal through with its code', async () => {
    const result = await downloadSessionFileInRanges({
      path: 'out/huge.bin',
      readRange: async () => ({ status: 'error', v: 1, code: 'too_large', message: 'Too big.' }),
    });

    expect(result).toEqual({ status: 'error', code: 'too_large', message: 'Too big.' });
  });
});

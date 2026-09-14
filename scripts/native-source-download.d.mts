export interface NativeSourceIdentity {
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface NativeSourceResponseBody extends AsyncIterable<Uint8Array> {
  cancel?: () => void | Promise<void>;
}

export interface NativeSourceResponse {
  ok: boolean;
  status: number;
  body?: NativeSourceResponseBody | null;
}

export interface NativeSourceDownloadOptions {
  fetchImpl?: (url: string, init: { signal: AbortSignal }) => Promise<NativeSourceResponse>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
}

export const NATIVE_SOURCE_MAX_ATTEMPTS: 3;
export const NATIVE_SOURCE_RETRY_DELAYS_MS: readonly [1_000, 2_000];
export const NATIVE_SOURCE_ATTEMPT_TIMEOUT_MS: 180_000;

export function downloadNativeSource(
  source: NativeSourceIdentity,
  options?: NativeSourceDownloadOptions,
): Promise<Buffer>;

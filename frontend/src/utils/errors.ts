/**
 * @file frontend/src/utils/errors.ts
 * @desc Centralizes the `error.response?.data?.details || error.message` pattern
 * used across the pages, with type-safe narrowing of axios errors.
 */
import { isAxiosError } from 'axios';

interface ApiErrorBody {
  details?: string;
  error?: string;
  message?: string;
}

/** Best-effort human-facing message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as ApiErrorBody | undefined;
    return data?.details || data?.error || data?.message || error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The server error payload (for console logging), or the raw error. */
export function errorData(error: unknown): unknown {
  return isAxiosError(error) ? error.response?.data : error;
}

/** Narrowed axios HTTP status, or undefined for non-axios / no-response errors. */
export function errorStatus(error: unknown): number | undefined {
  return isAxiosError(error) ? error.response?.status : undefined;
}

/**
 * The backend error CODE — the stable machine-readable `error` field of the
 * JSON body (e.g. "VOTING_DURATION_EXCEEDS_MAXIMUM"), NOT the human `details`
 * sentence that `errorMessage` returns. Undefined for non-axios / no-response.
 */
export function errorCode(error: unknown): string | undefined {
  if (isAxiosError(error)) {
    const data = error.response?.data as ApiErrorBody | undefined;
    return data?.error;
  }
  return undefined;
}

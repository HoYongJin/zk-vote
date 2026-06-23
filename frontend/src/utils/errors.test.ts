import { describe, test, expect } from 'vitest';
import { errorCode, errorMessage, errorStatus } from './errors';

/** A minimal axios-shaped error (isAxiosError flag is all axios's guard checks). */
const axiosErr = (status: number, data: Record<string, unknown>) => ({
  isAxiosError: true,
  message: 'request failed',
  response: { status, data },
});

describe('error helpers', () => {
  test('errorCode returns the machine-readable `error` field', () => {
    const err = axiosErr(400, {
      error: 'VOTING_DURATION_EXCEEDS_MAXIMUM',
      details: '투표 기간이 최대치를 초과합니다',
    });
    expect(errorCode(err)).toBe('VOTING_DURATION_EXCEEDS_MAXIMUM');
    // L-fe-confirm: errorMessage returns the human `details` sentence, NOT the
    // code — so the confirm-retry branch MUST key off errorCode, not errorMessage.
    expect(errorMessage(err)).toBe('투표 기간이 최대치를 초과합니다');
    expect(errorStatus(err)).toBe(400);
  });

  test('errorCode is undefined for non-axios errors and when the field is absent', () => {
    expect(errorCode(new Error('boom'))).toBeUndefined();
    expect(errorCode(axiosErr(500, { details: 'no code here' }))).toBeUndefined();
  });
});

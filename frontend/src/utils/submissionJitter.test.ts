import { describe, test, expect } from 'vitest';
import {
  calculateSubmissionJitterMs,
  SUBMISSION_JITTER_MAX_MS,
  SUBMISSION_TICKET_SAFETY_BUFFER_MS,
  SUBMISSION_TICKET_TTL_MS,
} from './submissionJitter';

describe('submission jitter', () => {
  test('picks a bounded jitter while the ticket has enough TTL budget', () => {
    const jitter = calculateSubmissionJitterMs({
      ticketIssuedAtMs: 1_000,
      nowMs: 2_000,
      random: () => 0.5,
    });

    expect(jitter).toBe(Math.floor((SUBMISSION_JITTER_MAX_MS + 1) / 2));
  });

  test('shrinks the jitter to the remaining safe ticket budget', () => {
    const safeRemaining = 2_000;
    const nowMs = SUBMISSION_TICKET_TTL_MS - SUBMISSION_TICKET_SAFETY_BUFFER_MS - safeRemaining;

    const jitter = calculateSubmissionJitterMs({
      ticketIssuedAtMs: 0,
      nowMs,
      random: () => 1,
    });

    expect(jitter).toBe(safeRemaining);
  });

  test('returns zero when proof generation has consumed the safe ticket budget', () => {
    const jitter = calculateSubmissionJitterMs({
      ticketIssuedAtMs: 0,
      nowMs: SUBMISSION_TICKET_TTL_MS - SUBMISSION_TICKET_SAFETY_BUFFER_MS + 1,
      random: () => 1,
    });

    expect(jitter).toBe(0);
  });

  test('clamps invalid random samples instead of returning NaN', () => {
    expect(
      calculateSubmissionJitterMs({
        ticketIssuedAtMs: 1_000,
        nowMs: 1_000,
        random: () => Number.NaN,
      }),
    ).toBe(0);

    expect(
      calculateSubmissionJitterMs({
        ticketIssuedAtMs: 1_000,
        nowMs: 1_000,
        random: () => 2,
      }),
    ).toBe(SUBMISSION_JITTER_MAX_MS);
  });
});

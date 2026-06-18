export const SUBMISSION_TICKET_TTL_MS = 300_000;
export const SUBMISSION_TICKET_SAFETY_BUFFER_MS = 30_000;
export const SUBMISSION_JITTER_MAX_MS = 10_000;

export function randomFraction() {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const bytes = new Uint32Array(1);
    window.crypto.getRandomValues(bytes);
    return bytes[0] / 0x100000000;
  }
  return Math.random();
}

export function calculateSubmissionJitterMs({
  ticketIssuedAtMs,
  nowMs = Date.now(),
  random = randomFraction,
  ttlMs = SUBMISSION_TICKET_TTL_MS,
  safetyBufferMs = SUBMISSION_TICKET_SAFETY_BUFFER_MS,
  maxJitterMs = SUBMISSION_JITTER_MAX_MS,
} = {}) {
  if (!Number.isFinite(ticketIssuedAtMs)) {
    return 0;
  }

  const elapsedMs = Math.max(0, nowMs - ticketIssuedAtMs);
  const remainingBudgetMs = ttlMs - safetyBufferMs - elapsedMs;
  const allowedJitterMs = Math.min(maxJitterMs, Math.max(0, remainingBudgetMs));
  if (allowedJitterMs <= 0) {
    return 0;
  }

  const rawSample = random();
  const sample = Number.isFinite(rawSample) ? Math.min(1, Math.max(0, rawSample)) : 0;
  return Math.min(allowedJitterMs, Math.floor(sample * (allowedJitterMs + 1)));
}

export function delay(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

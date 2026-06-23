import { describe, test, expect, afterEach, vi } from 'vitest';
import { getApiBaseUrl, resolveApiPath, resolveArtifactApiPath } from './apiBaseUrl';

describe('apiBaseUrl utilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('defaults missing or root configuration to /api', () => {
    vi.stubEnv('VITE_API_BASE_URL', undefined);
    expect(getApiBaseUrl()).toBe('/api');

    vi.stubEnv('VITE_API_BASE_URL', '/');
    expect(getApiBaseUrl()).toBe('/api');
  });

  test('normalizes configured API base URL trailing slashes', () => {
    vi.stubEnv('VITE_API_BASE_URL', ' http://localhost:8080/api/ ');
    expect(getApiBaseUrl()).toBe('http://localhost:8080/api');
  });

  test('resolves server-provided API paths against a separate API origin', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8080/api');
    expect(resolveApiPath('/api/zkp-files/build_4_5/circuit_final.zkey')).toBe(
      'http://localhost:8080/api/zkp-files/build_4_5/circuit_final.zkey',
    );
  });

  test('keeps relative API paths relative to the frontend origin', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api');
    expect(resolveApiPath('/api/zkp-files/build_4_5/circuit_final.zkey')).toBe(
      '/api/zkp-files/build_4_5/circuit_final.zkey',
    );
  });

  test('resolves artifact paths only through /api/zkp-files', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8080/api');
    expect(resolveArtifactApiPath('api/zkp-files/build_4_5/circuit_final.zkey')).toBe(
      'http://localhost:8080/api/zkp-files/build_4_5/circuit_final.zkey',
    );
  });

  test('rejects external artifact URLs from artifact-info responses', () => {
    expect(() => resolveArtifactApiPath('https://evil.example/circuit_final.zkey')).toThrow(
      /same-API relative paths/,
    );
    expect(() => resolveArtifactApiPath('//evil.example/api/zkp-files/circuit_final.zkey')).toThrow(
      /same-API relative paths/,
    );
  });

  test('rejects non-artifact API paths for proving artifacts', () => {
    expect(() => resolveArtifactApiPath('/api/elections/election-1/artifact-info')).toThrow(
      /\/api\/zkp-files/,
    );
    expect(() => resolveArtifactApiPath('/api/zkp-files/../server/.env')).toThrow(/traversal/);
  });
});

const API_PREFIX = '/api';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!configured || configured === '/') {
    return API_PREFIX;
  }
  return stripTrailingSlash(configured);
}

export function resolveApiPath(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const apiBaseUrl = getApiBaseUrl();
  if (/^https?:\/\//i.test(apiBaseUrl)) {
    return `${new URL(apiBaseUrl).origin}${normalizedPath}`;
  }
  return normalizedPath;
}

export function resolveArtifactApiPath(path: string): string {
  // Runtime guard: `path` originates from an untyped server response.
  if (typeof path !== 'string') {
    throw new Error('Artifact paths must be same-API relative paths.');
  }

  const trimmedPath = path.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedPath) || trimmedPath.startsWith('//')) {
    throw new Error('Artifact paths must be same-API relative paths.');
  }

  const normalizedPath = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`;
  if (!normalizedPath.startsWith('/api/zkp-files/')) {
    throw new Error('Artifact paths must be served from /api/zkp-files/.');
  }
  if (normalizedPath.split('/').includes('..')) {
    throw new Error('Artifact paths must not contain traversal segments.');
  }

  return resolveApiPath(normalizedPath);
}

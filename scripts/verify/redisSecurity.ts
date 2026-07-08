export function isAllowedExternalRedisUrl(redisUrl: string): boolean {
    return redisUrl.startsWith("rediss://");
}

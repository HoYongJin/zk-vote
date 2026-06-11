const crypto = require("crypto");

const DEFAULT_LOCK_TIMEOUT_SECONDS = 10;
const DEFAULT_POLLING_INTERVAL_MS = 100;
const DEFAULT_POLLING_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getDefaultRedis = () => require("../redisClient");

async function acquireRedisLock(
    key,
    {
        client = getDefaultRedis(),
        lockTimeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS,
        pollingIntervalMs = DEFAULT_POLLING_INTERVAL_MS,
        pollingTimeoutMs = DEFAULT_POLLING_TIMEOUT_MS,
    } = {}
) {
    const token = crypto.randomUUID();
    const startedAt = Date.now();

    while (true) {
        const lockAcquired = await client.set(
            key,
            token,
            "NX",
            "EX",
            lockTimeoutSeconds
        );

        if (lockAcquired) {
            return { key, token, client };
        }

        if (Date.now() - startedAt > pollingTimeoutMs) {
            throw new Error(`Failed to acquire Redis lock for ${key} within ${pollingTimeoutMs}ms.`);
        }

        await sleep(pollingIntervalMs);
    }
}

async function releaseRedisLock(lock) {
    if (!lock || !lock.key || !lock.token || !lock.client) {
        return 0;
    }

    const releaseScript = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        end
        return 0
    `;

    return lock.client.eval(releaseScript, 1, lock.key, lock.token);
}

async function isRedisLockHeld(lock) {
    if (!lock || !lock.key || !lock.token || !lock.client || typeof lock.client.get !== "function") {
        return false;
    }
    return (await lock.client.get(lock.key)) === lock.token;
}

async function withRedisLock(key, fn, options = {}) {
    const lock = await acquireRedisLock(key, options);
    try {
        return await fn(lock);
    } finally {
        await releaseRedisLock(lock);
    }
}

module.exports = {
    acquireRedisLock,
    isRedisLockHeld,
    releaseRedisLock,
    withRedisLock,
};

const { expect } = require("chai");
const {
    acquireRedisLock,
    releaseRedisLock,
    withRedisLock,
} = require("../server/utils/redisLock");

class FakeRedis {
    constructor({ alwaysLocked = false } = {}) {
        this.alwaysLocked = alwaysLocked;
        this.store = new Map();
    }

    async set(key, value, nx, ex, seconds) {
        expect(nx).to.equal("NX");
        expect(ex).to.equal("EX");
        expect(seconds).to.be.a("number");

        if (this.alwaysLocked || this.store.has(key)) {
            return null;
        }

        this.store.set(key, value);
        return "OK";
    }

    async get(key) {
        return this.store.get(key) || null;
    }

    async eval(script, keyCount, key, token) {
        expect(keyCount).to.equal(1);
        if (this.store.get(key) === token) {
            this.store.delete(key);
            return 1;
        }
        return 0;
    }
}

describe("redisLock", function () {
    it("acquires and releases a token-scoped lock", async function () {
        const client = new FakeRedis();

        const lock = await acquireRedisLock("lock:key", { client });
        expect(client.store.get("lock:key")).to.equal(lock.token);

        const released = await releaseRedisLock(lock);
        expect(released).to.equal(1);
        expect(client.store.has("lock:key")).to.equal(false);
    });

    it("releases the lock after a successful callback", async function () {
        const client = new FakeRedis();

        const result = await withRedisLock("lock:key", async () => "done", { client });

        expect(result).to.equal("done");
        expect(client.store.has("lock:key")).to.equal(false);
    });

    it("times out when the lock cannot be acquired", async function () {
        const client = new FakeRedis({ alwaysLocked: true });

        try {
            await acquireRedisLock("lock:key", {
                client,
                pollingIntervalMs: 1,
                pollingTimeoutMs: 5,
            });
            throw new Error("Expected acquireRedisLock to throw.");
        } catch (err) {
            expect(err.message).to.include("Failed to acquire Redis lock");
        }
    });
});

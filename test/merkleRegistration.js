const { expect } = require("chai");
const { withMockedModule } = require("./routeTestUtils");

function loadMerkleWithMocks({ currentUserId = "user-1", superseded = false } = {}) {
    const updates = [];
    const deletedKeys = [];

    function electionsBuilder() {
        let selected = null;
        const chain = {
            select: (columns) => {
                selected = columns;
                return chain;
            },
            eq: () => chain,
            single: async () => {
                if (selected === "superseded_at") {
                    return {
                        data: {
                            superseded_at: superseded ? new Date().toISOString() : null,
                        },
                        error: null,
                    };
                }
                return {
                    data: {
                        registration_end_time: new Date(Date.now() + 60_000).toISOString(),
                        merkle_root: null,
                    },
                    error: null,
                };
            },
        };
        return chain;
    }

    function votersBuilder() {
        const filters = [];
        let updatePayload = null;
        let selected = null;

        const chain = {
            select: (columns) => {
                selected = columns;
                return chain;
            },
            update: (payload) => {
                updatePayload = payload;
                updates.push(payload);
                return chain;
            },
            eq: (column, value) => {
                filters.push([column, value]);
                return chain;
            },
            is: (column, value) => {
                filters.push([column, value]);
                return chain;
            },
            maybeSingle: async () => {
                if (updatePayload) {
                    const isInitialBind = filters.some(([column, value]) => column === "user_id" && value === null);
                    return {
                        data: isInitialBind ? null : { id: "voter-1" },
                        error: null,
                    };
                }
                if (selected === "id, user_id") {
                    return {
                        data: { id: "voter-1", user_id: currentUserId },
                        error: null,
                    };
                }
                return { data: null, error: null };
            },
        };
        return chain;
    }

    const restoreSupabase = withMockedModule("../server/supabaseClient", {
        from: (table) => (table === "Elections" ? electionsBuilder() : votersBuilder()),
    });
    const restoreRedis = withMockedModule("../server/redisClient", {
        del: async (key) => {
            deletedKeys.push(key);
            return 1;
        },
    });
    const restoreRedisLock = withMockedModule("../server/utils/redisLock", {
        withRedisLock: async (_key, fn) => fn({ key: "lock", token: "token", client: {} }),
        isRedisLockHeld: async () => true,
    });
    const restoreFinalization = withMockedModule("../server/utils/finalizationState", {
        isOnchainConfigured: async () => false,
    });

    const routePath = require.resolve("../server/utils/merkle");
    delete require.cache[routePath];
    const merkle = require("../server/utils/merkle");

    return {
        deletedKeys,
        merkle,
        updates,
        cleanup: () => {
            delete require.cache[routePath];
            restoreFinalization();
            restoreRedisLock();
            restoreRedis();
            restoreSupabase();
        },
    };
}

describe("merkle registration helper", function () {
    afterEach(function () {
        if (this.cleanupMerkle) {
            this.cleanupMerkle();
            this.cleanupMerkle = null;
        }
    });

    it("re-binds a new commitment for the same user before registration closes (AR-H6)", async function () {
        const { merkle, cleanup, updates, deletedKeys } = loadMerkleWithMocks();
        this.cleanupMerkle = cleanup;

        const result = await merkle.addUserSecret(
            "election-1",
            "Alice",
            "user-1",
            "alice@example.com",
            "0x1c8"
        );

        expect(result).to.deep.equal({ id: "voter-1" });
        expect(updates).to.deep.equal([
            { name: "Alice", user_id: "user-1", user_secret: "456" },
            { name: "Alice", user_secret: "456" },
        ]);
        expect(deletedKeys).to.deep.equal(["merkle_cache:leaves:election-1"]);
    });

    it("does not re-bind a commitment for a different already-bound user", async function () {
        const { merkle, cleanup, updates, deletedKeys } = loadMerkleWithMocks({ currentUserId: "other-user" });
        this.cleanupMerkle = cleanup;

        let thrown;
        try {
            await merkle.addUserSecret(
                "election-1",
                "Mallory",
                "user-1",
                "alice@example.com",
                "789"
            );
        } catch (err) {
            thrown = err;
        }

        expect(thrown).to.exist;
        expect(thrown.code).to.equal("ALREADY_REGISTERED");
        expect(updates).to.deep.equal([
            { name: "Mallory", user_id: "user-1", user_secret: "789" },
        ]);
        expect(deletedKeys).to.deep.equal([]);
    });

    it("fails closed inside the registration lock for superseded elections", async function () {
        const { merkle, cleanup, updates, deletedKeys } = loadMerkleWithMocks({ superseded: true });
        this.cleanupMerkle = cleanup;

        let thrown;
        try {
            await merkle.addUserSecret(
                "election-1",
                "Alice",
                "user-1",
                "alice@example.com",
                "123"
            );
        } catch (err) {
            thrown = err;
        }

        expect(thrown).to.exist;
        expect(thrown.code).to.equal("ELECTION_SUPERSEDED");
        expect(updates).to.deep.equal([]);
        expect(deletedKeys).to.deep.equal([]);
    });
});

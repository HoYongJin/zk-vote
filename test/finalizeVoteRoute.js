const path = require("path");
const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

// finalizeVote.js resolves ethers from server/node_modules (v5). Mock THAT
// module, not the root ethers (v6), which hardhat-chai-matchers depends on.
const serverEthersPath = require.resolve("ethers", {
    paths: [path.join(__dirname, "..", "server", "routes")],
});

function createSupabaseMock({ events }) {
    const updates = [];

    function electionsBuilder() {
        let updatePayload = null;
        const chain = {
            select: () => chain,
            eq: () => chain,
            is: () => chain,
            single: async () => {
                if (updatePayload) {
                    updates.push(updatePayload);
                    if (updatePayload.registration_end_time && !updatePayload.merkle_root) {
                        events.push("close-registration");
                    }
                    if (updatePayload.merkle_root) {
                        events.push("db-sync");
                    }
                    return { data: { id: "election-1" }, error: null };
                }
                return {
                    data: {
                        contract_address: "0x0000000000000000000000000000000000000001",
                        merkle_root: null,
                        registration_end_time: new Date(Date.now() + 3_600_000).toISOString(),
                    },
                    error: null,
                };
            },
            update: (payload) => {
                updatePayload = payload;
                return chain;
            },
        };
        return chain;
    }

    return {
        updates,
        from: () => electionsBuilder(),
    };
}

function loadFinalizeRoute({
    events,
    configured = false,
    snapshotRoots = ["42", "42"],
    snapshotLeaves = ["11", "22"],
    onchainRoot = "42",
    superseded = false,
} = {}) {
    const previousRpc = process.env.SEPOLIA_RPC_URL;
    const previousKey = process.env.PRIVATE_KEY;
    process.env.SEPOLIA_RPC_URL = "http://127.0.0.1:8545";
    process.env.PRIVATE_KEY = "0x" + "11".repeat(32);

    const markedConfigured = [];
    let snapshotCall = 0;

    const supabaseMock = createSupabaseMock({ events });
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const restoreAuthAdmin = withMockedModule("../server/middleware/authAdmin", (req, _res, next) => {
        req.admin = { id: "admin-1" };
        next();
    });
    const restoreMerkle = withMockedModule("../server/utils/merkle", {
        withElectionMerkleLock: async (_electionId, fn) =>
            fn({ key: "merkle_lock:election-1", token: "token-1", client: {} }),
        buildFinalMerkleSnapshot: async () => {
            const root = snapshotRoots[Math.min(snapshotCall, snapshotRoots.length - 1)];
            snapshotCall += 1;
            return {
                tree: { root: { toString: () => root } },
                leaves: snapshotLeaves,
                registrationClosedAt: new Date().toISOString(),
            };
        },
    });
    const restoreRedisLock = withMockedModule("../server/utils/redisLock", {
        isRedisLockHeld: async () => true,
    });
    const restoreFinalization = withMockedModule("../server/utils/finalizationState", {
        markOnchainConfigured: async (electionId, payload) => {
            markedConfigured.push({ electionId, payload });
        },
    });
    const restoreSupersede = withMockedModule("../server/utils/supersede", {
        isElectionSuperseded: async () => superseded,
    });

    const contractMock = {
        configured: async () => configured,
        merkleRoot: async () => ({ toString: () => onchainRoot }),
        votingStartTime: async () => ({ toString: () => String(Math.floor(Date.now() / 1000)) }),
        votingEndTime: async () => ({ toString: () => String(Math.floor(Date.now() / 1000) + 3600) }),
        configureElection: async () => {
            events.push("configureElection");
            return {
                wait: async () => ({
                    gasUsed: { toString: () => "21000" },
                    transactionHash: "0xconfigure",
                }),
            };
        },
    };
    const restoreEthers = withMockedModule(serverEthersPath, {
        ethers: {
            providers: { JsonRpcProvider: function JsonRpcProvider() {} },
            Wallet: function Wallet() {},
            Contract: function Contract() { return contractMock; },
        },
    });

    const routePath = require.resolve("../server/routes/finalizeVote");
    delete require.cache[routePath];
    const router = require("../server/routes/finalizeVote");

    return {
        router,
        supabaseMock,
        markedConfigured,
        cleanup: () => {
            delete require.cache[routePath];
            restoreEthers();
            restoreSupersede();
            restoreFinalization();
            restoreRedisLock();
            restoreMerkle();
            restoreAuthAdmin();
            restoreSupabase();
            process.env.SEPOLIA_RPC_URL = previousRpc;
            process.env.PRIVATE_KEY = previousKey;
        },
    };
}

describe("finalizeVote route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("durably closes registration in Postgres before any on-chain side effect (audit H4/M3)", async function () {
        const events = [];
        const { router, cleanup } = loadFinalizeRoute({ events });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { voteEndTime: new Date(Date.now() + 3_600_000).toISOString() },
        });

        expect(response.status).to.equal(200);
        expect(events).to.deep.equal(["close-registration", "configureElection", "db-sync"]);
    });

    it("does not close registration when zero-voter finalization is rejected", async function () {
        const events = [];
        const { router, cleanup } = loadFinalizeRoute({
            events,
            snapshotLeaves: [],
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { voteEndTime: new Date(Date.now() + 3_600_000).toISOString() },
        });

        expect(response.status).to.equal(400);
        expect(response.body.error).to.equal("NO_VOTERS_REGISTERED");
        expect(events).to.deep.equal([]);
    });

    it("rejects superseded elections before closing registration or configuring on-chain state", async function () {
        const events = [];
        const { router, cleanup } = loadFinalizeRoute({
            events,
            superseded: true,
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { voteEndTime: new Date(Date.now() + 3_600_000).toISOString() },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ELECTION_SUPERSEDED");
        expect(events).to.deep.equal([]);
    });

    it("recovers idempotently when the contract is already configured with the same root (audit H4)", async function () {
        const events = [];
        const { router, cleanup, markedConfigured, supabaseMock } = loadFinalizeRoute({
            events,
            configured: true,
            onchainRoot: "42",
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { voteEndTime: new Date(Date.now() + 3_600_000).toISOString() },
        });

        // On-chain succeeded previously but the DB sync was lost: the retry must
        // complete the DB sync without re-broadcasting a transaction.
        expect(response.status).to.equal(200);
        expect(events).to.not.include("configureElection");
        expect(events).to.include("db-sync");
        expect(markedConfigured).to.have.length(1);
        const dbSync = supabaseMock.updates.find((u) => u.merkle_root);
        expect(dbSync.merkle_root).to.equal("42");
    });

    it("refuses to reconcile when the contract holds a different root (audit H4)", async function () {
        const events = [];
        const { router, cleanup } = loadFinalizeRoute({
            events,
            configured: true,
            onchainRoot: "999",
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { voteEndTime: new Date(Date.now() + 3_600_000).toISOString() },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ON_CHAIN_STATE_MISMATCH");
        expect(events).to.not.include("db-sync");
    });

    it("aborts the DB sync when the voter snapshot changed after on-chain success (audit H4)", async function () {
        const events = [];
        const { router, cleanup } = loadFinalizeRoute({
            events,
            snapshotRoots: ["42", "43"],
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { voteEndTime: new Date(Date.now() + 3_600_000).toISOString() },
        });

        expect(response.status).to.equal(500);
        expect(response.body.error).to.equal("FINALIZATION_SNAPSHOT_CHANGED");
        expect(events).to.include("configureElection");
        expect(events).to.not.include("db-sync");
    });
});

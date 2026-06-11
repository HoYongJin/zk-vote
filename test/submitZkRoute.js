const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function createElectionSupabaseMock() {
    const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({
            data: {
                contract_address: "0x0000000000000000000000000000000000000001",
                voting_start_time: new Date(Date.now() - 60_000).toISOString(),
                voting_end_time: new Date(Date.now() + 60_000).toISOString(),
                merkle_root: "123",
                num_candidates: 3,
            },
            error: null,
        }),
    };
    return { from: () => chain };
}

function loadSubmitRoute({
    supabaseMock = {},
    ticketMock,
    redisLockMock,
} = {}) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const restoreTickets = ticketMock
        ? withMockedModule("../server/utils/submissionTickets", ticketMock)
        : () => {};
    const restoreRedisLock = redisLockMock
        ? withMockedModule("../server/utils/redisLock", redisLockMock)
        : () => {};

    const routePath = require.resolve("../server/routes/submitZk");
    delete require.cache[routePath];
    const router = require("../server/routes/submitZk");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreRedisLock();
            restoreTickets();
            restoreSupabase();
        },
    };
}

describe("submitZk route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("rejects malformed proof/publicSignals before ticket or relayer checks", async function () {
        const { router, cleanup } = loadSubmitRoute();
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: {
                formattedProof: { a: ["1"], b: [], c: ["2"] },
                publicSignals: ["1", "2"],
                submissionTicket: "ticket",
            },
        });

        expect(response.status).to.equal(400);
        expect(response.body.error).to.equal("INVALID_PAYLOAD");
    });

    it("rejects a well-formed proof carrying only 3 public signals (v1 shape)", async function () {
        const { router, cleanup } = loadSubmitRoute();
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: {
                // Structurally valid Groth16 proof, but the v1 3-signal shape is
                // no longer accepted after the C1 fix (now requires election_id).
                formattedProof: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] },
                publicSignals: ["123", "1", "456"],
                submissionTicket: "ticket",
            },
        });

        expect(response.status).to.equal(400);
        expect(response.body.error).to.equal("INVALID_PAYLOAD");
    });

    it("does not consume a ticket when semantic validation fails", async function () {
        const calls = { consumed: 0 };
        const previousRpc = process.env.SEPOLIA_RPC_URL;
        const previousKey = process.env.PRIVATE_KEY;
        process.env.SEPOLIA_RPC_URL = "http://127.0.0.1:8545";
        process.env.PRIVATE_KEY = "0x" + "11".repeat(32);

        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock(),
            ticketMock: {
                readSubmissionTicket: async () => ({
                    electionId: "00000000-0000-0000-0000-00000000007b",
                    merkleRoot: "123",
                    nullifierHash: "456",
                }),
                consumeSubmissionTicket: async () => {
                    calls.consumed += 1;
                    return null;
                },
            },
            redisLockMock: {
                withRedisLock: async (_key, fn) => fn(),
            },
            // No ethers mock: the route resolves server/node_modules ethers v5,
            // which constructs provider/wallet/contract offline. Semantic
            // validation fails before any contract call. Mocking "ethers" here
            // would instead poison the root ethers v6 used by chai matchers.
        });
        this.cleanupRoute = () => {
            cleanup();
            process.env.SEPOLIA_RPC_URL = previousRpc;
            process.env.PRIVATE_KEY = previousKey;
        };

        const response = await invokeJson(router, {
            params: { election_id: "00000000-0000-0000-0000-00000000007b" },
            body: {
                formattedProof: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] },
                // Wrong election id public signal.
                publicSignals: ["123", "1", "456", "999"],
                submissionTicket: "ticket",
            },
        });

        expect(response.status).to.equal(400);
        expect(response.body.error).to.equal("ELECTION_ID_MISMATCH");
        expect(calls.consumed).to.equal(0);
    });
});

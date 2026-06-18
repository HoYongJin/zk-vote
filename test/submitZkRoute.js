const path = require("path");
const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

// submitZk.js resolves ethers from server/node_modules (v5). When a contract
// mock is needed, replace THAT module — never the root ethers (v6), which
// hardhat-chai-matchers depends on.
const serverEthersPath = require.resolve("ethers", {
    paths: [path.join(__dirname, "..", "server", "routes")],
});

function createElectionSupabaseMock(electionOverrides = {}) {
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
                ...electionOverrides,
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
    contractMock,
    superseded = false,
} = {}) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const restoreTickets = ticketMock
        ? withMockedModule("../server/utils/submissionTickets", ticketMock)
        : () => {};
    const restoreRedisLock = redisLockMock
        ? withMockedModule("../server/utils/redisLock", redisLockMock)
        : () => {};
    const restoreEthers = contractMock
        ? withMockedModule(serverEthersPath, {
            ethers: {
                providers: { JsonRpcProvider: function JsonRpcProvider() {} },
                Wallet: function Wallet() {},
                Contract: function Contract() { return contractMock; },
            },
        })
        : () => {};
    const restoreSupersede = withMockedModule("../server/utils/supersede", {
        isElectionSuperseded: async () => superseded,
    });

    const routePath = require.resolve("../server/routes/submitZk");
    delete require.cache[routePath];
    const router = require("../server/routes/submitZk");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreSupersede();
            restoreEthers();
            restoreRedisLock();
            restoreTickets();
            restoreSupabase();
        },
    };
}

function withRelayerEnv() {
    const previousRpc = process.env.SEPOLIA_RPC_URL;
    const previousKey = process.env.PRIVATE_KEY;
    process.env.SEPOLIA_RPC_URL = "http://127.0.0.1:8545";
    process.env.PRIVATE_KEY = "0x" + "11".repeat(32);
    return () => {
        process.env.SEPOLIA_RPC_URL = previousRpc;
        process.env.PRIVATE_KEY = previousKey;
    };
}

// Election UUID whose electionIdToBigInt value is 0x7b = 123.
const ELECTION_UUID = "00000000-0000-0000-0000-00000000007b";

function validSubmitBody() {
    return {
        formattedProof: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] },
        // [root, candidateIndex, nullifierHash, electionId]
        publicSignals: ["123", "1", "456", "123"],
        submissionTicket: "ticket",
    };
}

describe("submitZk route", function () {
    let RealDate;

    function freezeDate(isoString) {
        RealDate = global.Date;
        function MockDate(value) {
            if (!(this instanceof MockDate)) {
                return new RealDate(isoString).toString();
            }
            return value === undefined ? new RealDate(isoString) : new RealDate(value);
        }
        MockDate.now = () => new RealDate(isoString).getTime();
        MockDate.parse = RealDate.parse;
        MockDate.UTC = RealDate.UTC;
        MockDate.prototype = RealDate.prototype;
        global.Date = MockDate;
    }

    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
        if (RealDate) {
            global.Date = RealDate;
            RealDate = null;
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

    it("rejects a replayed or expired ticket with 403 (audit M1)", async function () {
        const restoreEnv = withRelayerEnv();
        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock(),
            ticketMock: {
                // GETDEL already happened (or TTL expired): nothing to read.
                readSubmissionTicket: async () => null,
                consumeSubmissionTicket: async () => null,
            },
            redisLockMock: { withRedisLock: async (_key, fn) => fn() },
        });
        this.cleanupRoute = () => {
            cleanup();
            restoreEnv();
        };

        const response = await invokeJson(router, {
            params: { election_id: ELECTION_UUID },
            body: validSubmitBody(),
        });

        expect(response.status).to.equal(403);
        expect(response.body.error).to.equal("INVALID_OR_EXPIRED_TICKET");
    });

    it("rejects malformed or legacy ticket payloads with 403", async function () {
        const restoreEnv = withRelayerEnv();
        const calls = { consumed: 0 };
        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock(),
            ticketMock: {
                readSubmissionTicket: async () => {
                    throw Object.assign(
                        new Error("Submission ticket payload must not include nullifierHash."),
                        { code: "INVALID_TICKET_PAYLOAD", status: 403 }
                    );
                },
                consumeSubmissionTicket: async () => {
                    calls.consumed += 1;
                    return null;
                },
            },
            redisLockMock: { withRedisLock: async (_key, fn) => fn() },
        });
        this.cleanupRoute = () => {
            cleanup();
            restoreEnv();
        };

        const response = await invokeJson(router, {
            params: { election_id: ELECTION_UUID },
            body: validSubmitBody(),
        });

        expect(response.status).to.equal(403);
        expect(response.body.error).to.equal("INVALID_OR_EXPIRED_TICKET");
        expect(calls.consumed).to.equal(0);
    });

    it("treats voting_end_time as an exclusive submit boundary before ticket read", async function () {
        const restoreEnv = withRelayerEnv();
        const boundary = "2026-06-12T00:00:00.000Z";
        freezeDate(boundary);
        const calls = { read: 0 };
        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock({
                voting_start_time: "2026-06-11T00:00:00.000Z",
                voting_end_time: boundary,
            }),
            ticketMock: {
                readSubmissionTicket: async () => {
                    calls.read += 1;
                    return null;
                },
                consumeSubmissionTicket: async () => null,
            },
            redisLockMock: { withRedisLock: async (_key, fn) => fn() },
        });
        this.cleanupRoute = () => {
            cleanup();
            restoreEnv();
        };

        const response = await invokeJson(router, {
            params: { election_id: ELECTION_UUID },
            body: validSubmitBody(),
        });

        expect(response.status).to.equal(403);
        expect(response.body.error).to.equal("VOTING_PERIOD_INACTIVE");
        expect(calls.read).to.equal(0);
    });

    it("rejects superseded elections before ticket read", async function () {
        const restoreEnv = withRelayerEnv();
        const calls = { read: 0 };
        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock(),
            superseded: true,
            ticketMock: {
                readSubmissionTicket: async () => {
                    calls.read += 1;
                    return null;
                },
                consumeSubmissionTicket: async () => null,
            },
            redisLockMock: { withRedisLock: async (_key, fn) => fn() },
        });
        this.cleanupRoute = () => {
            cleanup();
            restoreEnv();
        };

        const response = await invokeJson(router, {
            params: { election_id: ELECTION_UUID },
            body: validSubmitBody(),
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ELECTION_SUPERSEDED");
        expect(calls.read).to.equal(0);
    });

    it("does not consume the ticket when the contract preflight rejects the proof (audit M1)", async function () {
        const restoreEnv = withRelayerEnv();
        const calls = { consumed: 0 };
        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock(),
            ticketMock: {
                readSubmissionTicket: async () => ({
                    electionId: ELECTION_UUID,
                    merkleRoot: "123",
                }),
                consumeSubmissionTicket: async () => {
                    calls.consumed += 1;
                    return null;
                },
            },
            redisLockMock: { withRedisLock: async (_key, fn) => fn() },
            contractMock: {
                usedNullifiers: async () => false,
                callStatic: {
                    submitTally: async () => {
                        throw Object.assign(new Error("execution reverted"), {
                            reason: "VotingTally: Invalid proof",
                        });
                    },
                },
            },
        });
        this.cleanupRoute = () => {
            cleanup();
            restoreEnv();
        };

        const response = await invokeJson(router, {
            params: { election_id: ELECTION_UUID },
            body: validSubmitBody(),
        });

        expect(response.status).to.equal(400);
        expect(response.body.error).to.equal("PROOF_REJECTED");
        expect(calls.consumed).to.equal(0);
    });

    it("rejects an already-used on-chain nullifier without consuming the ticket", async function () {
        const restoreEnv = withRelayerEnv();
        const calls = { consumed: 0 };
        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock(),
            ticketMock: {
                readSubmissionTicket: async () => ({
                    electionId: ELECTION_UUID,
                    merkleRoot: "123",
                }),
                consumeSubmissionTicket: async () => {
                    calls.consumed += 1;
                    return null;
                },
            },
            redisLockMock: { withRedisLock: async (_key, fn) => fn() },
            contractMock: {
                usedNullifiers: async () => true,
                callStatic: { submitTally: async () => true },
            },
        });
        this.cleanupRoute = () => {
            cleanup();
            restoreEnv();
        };

        const response = await invokeJson(router, {
            params: { election_id: ELECTION_UUID },
            body: validSubmitBody(),
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("VOTE_ALREADY_CAST");
        expect(calls.consumed).to.equal(0);
    });

    it("serializes successful sends behind the relayer wallet lock (AR-M5)", async function () {
        const restoreEnv = withRelayerEnv();
        const calls = { consumed: 0, submitted: 0 };
        const lockKeys = [];
        const { router, cleanup } = loadSubmitRoute({
            supabaseMock: createElectionSupabaseMock(),
            ticketMock: {
                readSubmissionTicket: async () => ({
                    electionId: ELECTION_UUID,
                    merkleRoot: "123",
                }),
                consumeSubmissionTicket: async () => {
                    calls.consumed += 1;
                    return {
                        electionId: ELECTION_UUID,
                        merkleRoot: "123",
                    };
                },
            },
            redisLockMock: {
                withRedisLock: async (key, fn) => {
                    lockKeys.push(key);
                    return fn();
                },
            },
            contractMock: {
                usedNullifiers: async () => false,
                callStatic: { submitTally: async () => true },
                submitTally: async () => {
                    calls.submitted += 1;
                    return { wait: async () => ({ transactionHash: "0xtx" }) };
                },
            },
        });
        this.cleanupRoute = () => {
            cleanup();
            restoreEnv();
        };

        const response = await invokeJson(router, {
            params: { election_id: ELECTION_UUID },
            body: validSubmitBody(),
        });

        expect(response.status).to.equal(200);
        expect(response.body.transactionHash).to.equal("0xtx");
        expect(calls.consumed).to.equal(1);
        expect(calls.submitted).to.equal(1);
        expect(lockKeys).to.deep.equal([
            "submit:ticket:ticket",
            `submit:nullifier:${ELECTION_UUID}:456`,
            "submit:relayer-wallet",
        ]);
    });
});

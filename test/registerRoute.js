const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");
const { FIELD_ELEMENT_MODULUS_DEC } = require("../server/utils/fieldElement");

function createSupabaseMock({ registrationEndOffsetMs = 60_000, voterUserId = null } = {}) {
    let fromCalls = 0;

    function electionBuilder() {
        const chain = {
            select: () => chain,
            eq: () => chain,
            single: async () => ({
                data: {
                    id: "election-1",
                    registration_end_time: new Date(Date.now() + registrationEndOffsetMs).toISOString(),
                },
                error: null,
            }),
        };
        return chain;
    }

    function voterBuilder() {
        const chain = {
            select: () => chain,
            eq: () => chain,
            single: async () => ({
                data: { id: "voter-1", user_id: voterUserId },
                error: null,
            }),
        };
        return chain;
    }

    return {
        from: () => {
            fromCalls += 1;
            return fromCalls === 1 ? electionBuilder() : voterBuilder();
        },
    };
}

function loadRegisterRoute({
    addUserSecret = async () => ({ id: "voter-1" }),
    registrationEndOffsetMs = 60_000,
    superseded = false,
    voterUserId = null,
} = {}) {
    const calls = [];
    const restoreSupabase = withMockedModule("../server/supabaseClient", createSupabaseMock({ registrationEndOffsetMs, voterUserId }));
    const restoreAuth = withMockedModule("../server/middleware/auth", (req, _res, next) => {
        req.user = { id: "user-1", email: "User@Example.com" };
        next();
    });
    const restoreMerkle = withMockedModule("../server/utils/merkle", {
        addUserSecret: async (...args) => {
            calls.push(args);
            return addUserSecret(...args);
        },
    });
    const restoreSupersede = withMockedModule("../server/utils/supersede", {
        isElectionSuperseded: async () => superseded,
    });

    const routePath = require.resolve("../server/routes/register");
    delete require.cache[routePath];
    const router = require("../server/routes/register");

    return {
        calls,
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreSupersede();
            restoreMerkle();
            restoreAuth();
            restoreSupabase();
        },
    };
}

describe("register route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("requires a client-generated secret commitment", async function () {
        const { router, cleanup } = loadRegisterRoute();
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { name: "Alice" },
        });

        expect(response.status).to.equal(400);
        expect(response.body.error).to.equal("VALIDATION_ERROR");
    });

    it("rejects secret commitments outside the BN254 scalar field", async function () {
        const { router, cleanup, calls } = loadRegisterRoute();
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { name: "Alice", secretCommitment: FIELD_ELEMENT_MODULUS_DEC },
        });

        expect(response.status).to.equal(400);
        expect(response.body.error).to.equal("VALIDATION_ERROR");
        expect(calls).to.deep.equal([]);
    });

    it("stores the commitment, not a backend-generated plaintext secret", async function () {
        const { router, cleanup, calls } = loadRegisterRoute();
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { name: " Alice ", secretCommitment: "0x7b" },
        });

        expect(response.status).to.equal(200);
        expect(calls).to.deep.equal([
            ["election-1", "Alice", "user-1", "user@example.com", "123"],
        ]);
    });

    it("allows the same authenticated user to re-bind a commitment before finalization (AR-H6)", async function () {
        const { router, cleanup, calls } = loadRegisterRoute({ voterUserId: "user-1" });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { name: "Alice", secretCommitment: "456" },
        });

        expect(response.status).to.equal(200);
        expect(calls).to.deep.equal([
            ["election-1", "Alice", "user-1", "user@example.com", "456"],
        ]);
    });

    it("rejects an already-bound allowlist row for a different authenticated user", async function () {
        const { router, cleanup, calls } = loadRegisterRoute({ voterUserId: "other-user" });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { name: "Mallory", secretCommitment: "456" },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ALREADY_REGISTERED");
        expect(calls).to.deep.equal([]);
    });

    it("rejects registration once registration is durably closed in Postgres (audit H4/M3 fail-closed)", async function () {
        // finalize moves registration_end_time to now in Postgres BEFORE any
        // on-chain side effect, so this deadline check alone keeps registration
        // closed across crashes and Redis marker loss.
        const { router, cleanup, calls } = loadRegisterRoute({ registrationEndOffsetMs: -60_000 });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { name: "Late", secretCommitment: "123" },
        });

        expect(response.status).to.equal(403);
        expect(response.body.error).to.equal("REGISTRATION_PERIOD_ENDED");
        expect(calls).to.deep.equal([]);
    });

    it("rejects superseded elections before storing a voter commitment", async function () {
        const { router, cleanup, calls } = loadRegisterRoute({ superseded: true });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { name: "Alice", secretCommitment: "123" },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ELECTION_SUPERSEDED");
        expect(calls).to.deep.equal([]);
    });
});

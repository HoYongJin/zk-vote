const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function createSupabaseMock({
    registrationEndOffsetMs = 60_000,
    merkleRoot = null,
    merkleTreeDepth = 2,
    existingEmails = [],
    currentVoterCount = 0,
} = {}) {
    const inserted = [];

    function electionsBuilder() {
        const chain = {
            select: () => chain,
            eq: () => chain,
            single: async () => ({
                data: {
                    id: "election-1",
                    registration_end_time: new Date(Date.now() + registrationEndOffsetMs).toISOString(),
                    merkle_root: merkleRoot,
                    merkle_tree_depth: merkleTreeDepth,
                },
                error: null,
            }),
        };
        return chain;
    }

    function votersBuilder() {
        // One builder serves all three Voters interactions:
        // - select().eq().in()            -> existing-email lookup
        // - select(, {count}).eq() await  -> capacity count (thenable chain)
        // - insert(batch)                 -> allowlist insert
        const chain = {
            select: () => chain,
            eq: () => chain,
            in: async () => ({
                data: existingEmails.map((email) => ({ email })),
                error: null,
            }),
            then: (resolve, reject) =>
                Promise.resolve({ count: currentVoterCount, error: null }).then(resolve, reject),
            insert: async (batch) => {
                inserted.push(...batch);
                return { error: null };
            },
        };
        return chain;
    }

    return {
        inserted,
        from: (table) => (table === "Elections" ? electionsBuilder() : votersBuilder()),
    };
}

function loadRegisterByAdminRoute(supabaseMock) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const restoreAuthAdmin = withMockedModule("../server/middleware/authAdmin", (req, _res, next) => {
        req.admin = { id: "admin-1" };
        next();
    });
    const restoreMerkle = withMockedModule("../server/utils/merkle", {
        withElectionMerkleLock: async (_electionId, fn) => fn(),
    });
    const restoreFinalization = withMockedModule("../server/utils/finalizationState", {
        isOnchainConfigured: async () => false,
    });

    const routePath = require.resolve("../server/routes/registerByAdmin");
    delete require.cache[routePath];
    const router = require("../server/routes/registerByAdmin");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreFinalization();
            restoreMerkle();
            restoreAuthAdmin();
            restoreSupabase();
        },
    };
}

describe("registerByAdmin route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("rejects allowlist additions beyond 2^depth Merkle capacity (AR-H2)", async function () {
        // depth 2 -> capacity 4; 3 already allowlisted + 2 new = 5 > 4.
        const supabaseMock = createSupabaseMock({ merkleTreeDepth: 2, currentVoterCount: 3 });
        const { router, cleanup } = loadRegisterByAdminRoute(supabaseMock);
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { emails: ["a@example.com", "b@example.com"] },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("OVER_CAPACITY");
        expect(supabaseMock.inserted).to.deep.equal([]);
    });

    it("accepts allowlist additions within Merkle capacity", async function () {
        const supabaseMock = createSupabaseMock({ merkleTreeDepth: 2, currentVoterCount: 2 });
        const { router, cleanup } = loadRegisterByAdminRoute(supabaseMock);
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { emails: ["a@example.com", "b@example.com"] },
        });

        expect(response.status).to.equal(200);
        expect(response.body.summary.newly_registered_count).to.equal(2);
        expect(supabaseMock.inserted).to.have.length(2);
    });

    it("rejects additions once registration is durably closed in Postgres (audit H4/M3 fail-closed)", async function () {
        // finalize pushes registration_end_time to now in Postgres BEFORE any
        // on-chain side effect, so the deadline check alone must fail closed
        // even when merkle_root is still null and Redis markers are gone.
        const supabaseMock = createSupabaseMock({ registrationEndOffsetMs: -60_000, merkleRoot: null });
        const { router, cleanup } = loadRegisterByAdminRoute(supabaseMock);
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
            body: { emails: ["late@example.com"] },
        });

        expect(response.status).to.equal(403);
        expect(response.body.error).to.equal("REGISTRATION_PERIOD_ENDED");
        expect(supabaseMock.inserted).to.deep.equal([]);
    });
});

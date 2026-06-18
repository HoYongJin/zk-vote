const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function createSupabaseMock({ fetchResult, updateResult }) {
    const calls = {
        updates: [],
    };

    function builder(result) {
        const chain = {
            select: () => chain,
            update: (payload) => {
                calls.updates.push(payload);
                return chain;
            },
            eq: () => chain,
            single: async () => result,
        };
        return chain;
    }

    let fromCalls = 0;
    return {
        calls,
        from: () => {
            fromCalls += 1;
            return fromCalls === 1 ? builder(fetchResult) : builder(updateResult);
        },
    };
}

function loadCompleteRoute(supabaseMock, { superseded = false } = {}) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const restoreAuth = withMockedModule("../server/middleware/authAdmin", (req, _res, next) => {
        req.admin = { id: "admin-id" };
        next();
    });
    const restoreSupersede = withMockedModule("../server/utils/supersede", {
        isElectionSuperseded: async () => superseded,
    });

    const routePath = require.resolve("../server/routes/completeVote");
    delete require.cache[routePath];
    const router = require("../server/routes/completeVote");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreSupersede();
            restoreAuth();
            restoreSupabase();
        },
    };
}

describe("completeVote route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("rejects completion before voting_end_time", async function () {
        const supabaseMock = createSupabaseMock({
            fetchResult: {
                data: {
                    id: "election-1",
                    completed: false,
                    voting_end_time: new Date(Date.now() + 60_000).toISOString(),
                },
                error: null,
            },
            updateResult: { data: null, error: null },
        });
        const { router, cleanup } = loadCompleteRoute(supabaseMock);
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(403);
        expect(response.body.error).to.equal("VOTING_PERIOD_ACTIVE");
        expect(supabaseMock.calls.updates).to.deep.equal([]);
    });

    it("rejects superseded elections before updating completion", async function () {
        const supabaseMock = createSupabaseMock({
            fetchResult: {
                data: {
                    id: "election-1",
                    completed: false,
                    voting_end_time: new Date(Date.now() - 60_000).toISOString(),
                },
                error: null,
            },
            updateResult: { data: null, error: null },
        });
        const { router, cleanup } = loadCompleteRoute(supabaseMock, { superseded: true });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ELECTION_SUPERSEDED");
        expect(supabaseMock.calls.updates).to.deep.equal([]);
    });

    it("marks an election completed after voting_end_time", async function () {
        const supabaseMock = createSupabaseMock({
            fetchResult: {
                data: {
                    id: "election-1",
                    completed: false,
                    voting_end_time: new Date(Date.now() - 60_000).toISOString(),
                },
                error: null,
            },
            updateResult: {
                data: { id: "election-1", completed: true },
                error: null,
            },
        });
        const { router, cleanup } = loadCompleteRoute(supabaseMock);
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(200);
        expect(response.body.success).to.equal(true);
        expect(supabaseMock.calls.updates).to.deep.equal([{ completed: true }]);
    });
});

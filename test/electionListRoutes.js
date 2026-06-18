const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function createQueryResult(resultFactory) {
    const chain = {
        select: () => chain,
        eq: () => chain,
        lt: () => chain,
        gt: () => chain,
        in: () => chain,
        not: () => chain,
        single: async () => resultFactory("single"),
        maybeSingle: async () => resultFactory("maybeSingle"),
        then: (resolve, reject) => Promise.resolve(resultFactory("then")).then(resolve, reject),
    };
    return chain;
}

function createSupabaseMock(elections) {
    return {
        from: (table) => createQueryResult((mode) => {
            if (table === "Admins" && mode === "single") {
                return { data: { id: "admin-1" }, error: null };
            }
            if (table === "Elections") {
                return { data: elections, error: null };
            }
            if (table === "Voters") {
                return { data: [], count: 0, error: null };
            }
            return { data: null, error: null };
        }),
    };
}

function loadListRoute(routeName, elections) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", createSupabaseMock(elections));
    const restoreAuth = withMockedModule("../server/middleware/auth", (req, _res, next) => {
        req.user = { id: "admin-1", email: "admin@example.com" };
        next();
    });
    const restoreSupersede = withMockedModule("../server/utils/supersede", {
        filterSupersededElections: async (_supabase, rows) =>
            (rows || []).filter((row) => row.id !== "superseded-election"),
    });

    const routePath = require.resolve(`../server/routes/${routeName}`);
    delete require.cache[routePath];
    const router = require(`../server/routes/${routeName}`);

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

describe("election list routes", function () {
    const elections = [
        { id: "active-election", name: "Active", candidates: [], completed: false },
        { id: "superseded-election", name: "Superseded", candidates: [], completed: false },
    ];

    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    for (const routeName of ["registerableVote", "finalizedVote", "completedVote"]) {
        it(`${routeName} hides superseded elections in the Node fallback`, async function () {
            const { router, cleanup } = loadListRoute(routeName, elections);
            this.cleanupRoute = cleanup;

            const response = await invokeJson(router, { method: "GET" });

            expect(response.status).to.equal(200);
            expect(response.body.map((row) => row.id)).to.deep.equal(["active-election"]);
        });
    }
});

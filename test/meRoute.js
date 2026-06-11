const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function loadMeRoute({ isAdmin }) {
    const restoreAuth = withMockedModule("../server/middleware/auth", (req, _res, next) => {
        req.user = { id: "user-1", email: "user@example.com" };
        next();
    });
    const restoreSupabase = withMockedModule("../server/supabaseClient", {
        from: () => ({
            select: function () { return this; },
            eq: function () { return this; },
            maybeSingle: async () => ({
                data: isAdmin ? { id: "user-1" } : null,
                error: null,
            }),
        }),
    });

    const routePath = require.resolve("../server/routes/me");
    delete require.cache[routePath];
    const router = require("../server/routes/me");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreSupabase();
            restoreAuth();
        },
    };
}

describe("me route (AR-H4 role endpoint)", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("reports is_admin=true for admins", async function () {
        const { router, cleanup } = loadMeRoute({ isAdmin: true });
        this.cleanupRoute = cleanup;
        const response = await invokeJson(router, { method: "GET" });
        expect(response.status).to.equal(200);
        expect(response.body).to.deep.equal({
            id: "user-1",
            email: "user@example.com",
            is_admin: true,
        });
    });

    it("reports is_admin=false for everyone else", async function () {
        const { router, cleanup } = loadMeRoute({ isAdmin: false });
        this.cleanupRoute = cleanup;
        const response = await invokeJson(router, { method: "GET" });
        expect(response.status).to.equal(200);
        expect(response.body.is_admin).to.equal(false);
    });
});

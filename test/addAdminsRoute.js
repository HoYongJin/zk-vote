const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function createSupabaseMock() {
    const calls = [];
    return {
        calls,
        auth: {
            admin: {
                listUsers: async () => ({
                    data: {
                        users: [{ id: "user-1", email: "Admin@Example.com" }],
                    },
                    error: null,
                }),
            },
        },
        from: (table) => ({
            upsert: async (payload, options) => {
                calls.push({ table, payload, options });
                return { error: null };
            },
        }),
    };
}

function loadAddAdminsRoute(supabaseMock) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const restoreAuth = withMockedModule("../server/middleware/authAdmin", (req, _res, next) => {
        req.admin = { id: "admin-id" };
        next();
    });

    const routePath = require.resolve("../server/routes/addAdmins");
    delete require.cache[routePath];
    const router = require("../server/routes/addAdmins");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreAuth();
            restoreSupabase();
        },
    };
}

describe("addAdmins route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("upserts an invitation and promotes an existing Supabase user", async function () {
        const supabaseMock = createSupabaseMock();
        const { router, cleanup } = loadAddAdminsRoute(supabaseMock);
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            body: {
                email: " admin@example.com ",
            },
        });

        expect(response.status).to.equal(201);
        expect(response.body.promotedExistingUser).to.equal(true);
        expect(supabaseMock.calls).to.deep.equal([
            {
                table: "AdminInvitations",
                payload: { email: "admin@example.com" },
                options: { onConflict: "email" },
            },
            {
                table: "Admins",
                payload: { id: "user-1" },
                options: { onConflict: "id" },
            },
        ]);
    });
});

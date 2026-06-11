const { expect } = require("chai");
const { withMockedModule } = require("./routeTestUtils");

function loadAuthMiddleware({ promoteInvitedAdmin } = {}) {
    const promotions = [];

    const restoreSupabase = withMockedModule("../server/supabaseClient", {
        auth: {
            getUser: async () => ({
                data: { user: { id: "user-1", email: "invited@example.com" } },
                error: null,
            }),
        },
    });
    const restoreInvitations = withMockedModule("../server/utils/adminInvitations", {
        promoteInvitedAdmin: promoteInvitedAdmin || (async (user) => {
            promotions.push(user.id);
            return { promoted: true, email: user.email };
        }),
    });

    const middlewarePath = require.resolve("../server/middleware/auth");
    delete require.cache[middlewarePath];
    const auth = require("../server/middleware/auth");

    return {
        auth,
        promotions,
        cleanup: () => {
            delete require.cache[middlewarePath];
            restoreInvitations();
            restoreSupabase();
        },
    };
}

function invokeAuth(auth) {
    return new Promise((resolve, reject) => {
        const req = { headers: { authorization: "Bearer token-1" } };
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ kind: "response", status: this.statusCode, body: payload, req });
            },
        };
        auth(req, res, () => resolve({ kind: "next", req })).catch(reject);
    });
}

describe("auth middleware", function () {
    afterEach(function () {
        if (this.cleanupAuth) {
            this.cleanupAuth();
            this.cleanupAuth = null;
        }
    });

    it("consumes a pending admin invitation on any authenticated request (audit H5)", async function () {
        const { auth, promotions, cleanup } = loadAuthMiddleware();
        this.cleanupAuth = cleanup;

        const outcome = await invokeAuth(auth);

        expect(outcome.kind).to.equal("next");
        expect(outcome.req.user.id).to.equal("user-1");
        expect(promotions).to.deep.equal(["user-1"]);
    });

    it("does not block voter flows when invitation promotion fails", async function () {
        const { auth, cleanup } = loadAuthMiddleware({
            promoteInvitedAdmin: async () => {
                throw new Error("AdminInvitations is unavailable");
            },
        });
        this.cleanupAuth = cleanup;

        const outcome = await invokeAuth(auth);

        expect(outcome.kind).to.equal("next");
        expect(outcome.req.user.id).to.equal("user-1");
    });
});

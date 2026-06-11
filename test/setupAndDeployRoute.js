const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function createSupabaseMock({ firstContractAddress = null, secondContractAddress = null }) {
    let electionCalls = 0;

    function electionsBuilder() {
        electionCalls += 1;
        const isFirst = electionCalls === 1;
        const chain = {
            select: () => chain,
            eq: () => chain,
            single: async () => ({
                data: isFirst
                    ? {
                        merkle_tree_depth: 4,
                        num_candidates: 5,
                        contract_address: firstContractAddress,
                    }
                    : { contract_address: secondContractAddress },
                error: null,
            }),
        };
        return chain;
    }

    return { from: () => electionsBuilder() };
}

function loadSetupRoute({ supabaseMock, lockKeys }) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const restoreAuthAdmin = withMockedModule("../server/middleware/authAdmin", (req, _res, next) => {
        req.admin = { id: "admin-1" };
        next();
    });
    const restoreRedisLock = withMockedModule("../server/utils/redisLock", {
        withRedisLock: async (key, fn) => {
            lockKeys.push(key);
            return fn({ key, token: "token-1", client: {} });
        },
    });

    const routePath = require.resolve("../server/routes/setupAndDeploy");
    delete require.cache[routePath];
    const router = require("../server/routes/setupAndDeploy");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreRedisLock();
            restoreAuthAdmin();
            restoreSupabase();
        },
    };
}

describe("setupAndDeploy route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("rejects before taking the lock when the contract is already deployed", async function () {
        const lockKeys = [];
        const { router, cleanup } = loadSetupRoute({
            supabaseMock: createSupabaseMock({ firstContractAddress: "0xdeployed" }),
            lockKeys,
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ALREADY_DEPLOYED");
        expect(lockKeys).to.deep.equal([]);
    });

    it("re-checks deployment state inside the artifact lock (audit H3 TOCTOU close)", async function () {
        // Simulates the losing side of a deploy race: the pre-lock check saw no
        // contract, but by the time the lock is held a concurrent request has
        // deployed. The in-lock re-check must stop this request before it can
        // regenerate artifacts or double-deploy.
        const lockKeys = [];
        const { router, cleanup } = loadSetupRoute({
            supabaseMock: createSupabaseMock({
                firstContractAddress: null,
                secondContractAddress: "0xwinner",
            }),
            lockKeys,
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ALREADY_DEPLOYED");
        // Serialized on the shared (depth, candidates) artifact combination, so
        // concurrent setups for the same combo cannot interleave setUpZk.sh runs.
        expect(lockKeys).to.deep.equal(["zkdeploy:artifact:4:5"]);
    });
});

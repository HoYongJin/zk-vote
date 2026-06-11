const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function loadArtifactInfoRoute({ manifest = {} } = {}) {
    const restoreAuth = withMockedModule("../server/middleware/auth", (req, _res, next) => {
        req.user = { id: "user-1", email: "user@example.com" };
        next();
    });
    const restoreArtifacts = withMockedModule("../server/utils/zkArtifacts", {
        readManifest: () => manifest,
    });

    const routePath = require.resolve("../server/routes/artifactInfo");
    delete require.cache[routePath];
    const router = require("../server/routes/artifactInfo");

    return {
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreArtifacts();
            restoreAuth();
        },
    };
}

describe("artifactInfo route", function () {
    afterEach(function () {
        if (this.cleanupRoute) {
            this.cleanupRoute();
            this.cleanupRoute = null;
        }
    });

    it("returns the deploy-time hashes and artifact paths (AR-M6)", async function () {
        const { router, cleanup } = loadArtifactInfoRoute({
            manifest: {
                "election-1": {
                    merkleTreeDepth: 4,
                    numCandidates: 5,
                    wasmSha256: "a".repeat(64),
                    zkeySha256: "b".repeat(64),
                    verificationKeySha256: "c".repeat(64),
                },
            },
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            method: "GET",
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(200);
        expect(response.body.wasmSha256).to.equal("a".repeat(64));
        expect(response.body.zkeySha256).to.equal("b".repeat(64));
        expect(response.body.wasmPath).to.equal(
            "/api/zkp-files/build_4_5/VoteCheck_temp_js/VoteCheck_temp.wasm"
        );
        expect(response.body.zkeyPath).to.equal("/api/zkp-files/build_4_5/circuit_final.zkey");
        expect(response.body.publicSignalCount).to.equal(4);
    });

    it("returns 404 for elections that predate the manifest", async function () {
        const { router, cleanup } = loadArtifactInfoRoute({ manifest: {} });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            method: "GET",
            params: { election_id: "legacy-election" },
        });

        expect(response.status).to.equal(404);
        expect(response.body.error).to.equal("ARTIFACTS_NOT_RECORDED");
    });
});

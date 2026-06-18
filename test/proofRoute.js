const { expect } = require("chai");
const { invokeJson, withMockedModule } = require("./routeTestUtils");

function createSupabaseMock(electionOverrides = {}) {
    let fromCalls = 0;

    function electionBuilder() {
        const chain = {
            select: () => chain,
            eq: () => chain,
            single: async () => ({
                data: {
                    id: "election-1",
                    voting_start_time: new Date(Date.now() - 60_000).toISOString(),
                    voting_end_time: new Date(Date.now() + 60_000).toISOString(),
                    merkle_root: "123",
                    ...electionOverrides,
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
                data: { user_secret: "999" },
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

function loadProofRoute({
    artifactCheck = { ok: true, checked: true },
    electionOverrides = {},
    superseded = false,
} = {}) {
    const calls = {
        proofCommitments: [],
        ticketPayloads: [],
        artifactChecks: [],
    };

    const restoreSupabase = withMockedModule("../server/supabaseClient", createSupabaseMock(electionOverrides));
    const restoreAuth = withMockedModule("../server/middleware/auth", (req, _res, next) => {
        req.user = { id: "user-1", email: "user@example.com" };
        next();
    });
    const restoreMerkle = withMockedModule("../server/utils/merkle", {
        generateMerkleProof: async (_electionId, commitment) => {
            calls.proofCommitments.push(commitment);
            return {
                root: "123",
                pathElements: ["1", "2", "3", "4"],
                pathIndices: [0, 0, 0, 0],
            };
        },
    });
    const restoreTickets = withMockedModule("../server/utils/submissionTickets", {
        issueSubmissionTicket: async (payload) => {
            calls.ticketPayloads.push(payload);
            return "ticket-1";
        },
    });
    const restoreArtifacts = withMockedModule("../server/utils/zkArtifacts", {
        verifyElectionArtifacts: (electionId) => {
            calls.artifactChecks.push(electionId);
            return artifactCheck;
        },
    });
    const restoreSupersede = withMockedModule("../server/utils/supersede", {
        isElectionSuperseded: async () => superseded,
    });

    const routePath = require.resolve("../server/routes/proof");
    delete require.cache[routePath];
    const router = require("../server/routes/proof");

    return {
        calls,
        router,
        cleanup: () => {
            delete require.cache[routePath];
            restoreSupersede();
            restoreArtifacts();
            restoreTickets();
            restoreMerkle();
            restoreAuth();
            restoreSupabase();
        },
    };
}

describe("proof route", function () {
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

    it("returns proof data without plaintext user_secret and issues an unlinked ticket", async function () {
        const { router, cleanup, calls } = loadProofRoute();
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(200);
        expect(response.body.success).to.equal(true);
        expect(response.body).to.not.have.property("user_secret");
        expect(response.body.submissionTicket).to.equal("ticket-1");
        expect(calls.proofCommitments).to.deep.equal(["999"]);
        expect(calls.ticketPayloads).to.deep.equal([
            { electionId: "election-1", merkleRoot: "123" },
        ]);
        expect(calls.artifactChecks).to.deep.equal(["election-1"]);
    });

    it("rejects proof generation when deployed artifacts were regenerated (audit M5)", async function () {
        const { router, cleanup, calls } = loadProofRoute({
            artifactCheck: {
                ok: false,
                checked: true,
                mismatches: ["zkeySha256"],
                reason: "Artifacts were regenerated after deployment: zkeySha256 changed.",
            },
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ARTIFACT_MISMATCH");
        // No proof or ticket may be produced against drifted artifacts.
        expect(calls.proofCommitments).to.deep.equal([]);
        expect(calls.ticketPayloads).to.deep.equal([]);
    });

    it("treats voting_end_time as an exclusive proof boundary", async function () {
        const boundary = "2026-06-12T00:00:00.000Z";
        freezeDate(boundary);
        const { router, cleanup, calls } = loadProofRoute({
            electionOverrides: {
                voting_start_time: "2026-06-11T00:00:00.000Z",
                voting_end_time: boundary,
            },
        });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(403);
        expect(response.body.error).to.equal("VOTING_ENDED");
        expect(calls.proofCommitments).to.deep.equal([]);
        expect(calls.ticketPayloads).to.deep.equal([]);
    });

    it("rejects superseded elections before artifact check or ticket issue", async function () {
        const { router, cleanup, calls } = loadProofRoute({ superseded: true });
        this.cleanupRoute = cleanup;

        const response = await invokeJson(router, {
            method: "POST",
            params: { election_id: "election-1" },
        });

        expect(response.status).to.equal(409);
        expect(response.body.error).to.equal("ELECTION_SUPERSEDED");
        expect(calls.artifactChecks).to.deep.equal([]);
        expect(calls.proofCommitments).to.deep.equal([]);
        expect(calls.ticketPayloads).to.deep.equal([]);
    });
});

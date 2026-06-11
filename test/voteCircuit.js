const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const h = require("./helpers/zkProof");

/**
 * Real-circuit tests for the C1/H1 fixes. Unlike the MockVerifier suite, these
 * generate genuine Groth16 proofs from the regenerated build_4_5 artifacts and
 * submit them through the real Groth16Verifier_4_5 + VotingTally, so they
 * exercise:
 *   - C1: a proof made for a different election_id is rejected on-chain;
 *   - H1: a witness with a non-boolean pathIndices value cannot be generated;
 *   - the new 4-public-signal shape end to end (proof -> submit -> tally).
 *
 * Proof generation is slow, so this whole describe runs with a long timeout.
 */
describe("VoteCheck circuit v2 (real proofs)", function () {
    this.timeout(180000);

    const DEPTH = 4;
    const CANDIDATES = 5;
    const ELECTION_ID = 123n; // also the on-chain immutable electionId
    const SECRET = 987654321098765432109876543210n;

    async function realProof(overrides = {}, opts = {}) {
        const { input } = await h.buildCircuitInput({
            depth: DEPTH,
            candidates: CANDIDATES,
            secret: SECRET,
            electionId: opts.electionId ?? ELECTION_ID,
            voteIndex: opts.voteIndex ?? 2,
            overrides,
        });
        const { proof, publicSignals } = await h.fullProve(input, DEPTH, CANDIDATES);
        return { input, proof, publicSignals };
    }

    async function deployRealVerifierFixture() {
        const [owner] = await ethers.getSigners();

        const Verifier = await ethers.getContractFactory("Groth16Verifier_4_5");
        const verifier = await Verifier.deploy();
        await verifier.waitForDeployment();

        const VotingTally = await ethers.getContractFactory("VotingTally");
        const votingTally = await VotingTally.deploy(
            await verifier.getAddress(),
            ELECTION_ID,
            CANDIDATES,
            owner.address
        );
        await votingTally.waitForDeployment();

        return { owner, verifier, votingTally };
    }

    it("generates a valid proof with 4 public signals in the expected order", async function () {
        const { input, proof, publicSignals } = await realProof();
        const expectedNullifier = await h.nullifierFor(SECRET, ELECTION_ID);

        expect(publicSignals).to.have.lengthOf(4);
        expect(publicSignals[0]).to.equal(input.root_in);          // root_out
        expect(publicSignals[1]).to.equal("2");                    // vote_index
        expect(publicSignals[2]).to.equal(expectedNullifier);      // nullifier_hash
        expect(publicSignals[3]).to.equal(ELECTION_ID.toString()); // election_id

        expect(await h.verifyProof(publicSignals, proof, DEPTH, CANDIDATES)).to.equal(true);
    });

    it("rejects a witness whose pathIndices is non-boolean (audit H1)", async function () {
        // A valid path is index 0 with a single leaf, so pathIndices are all 0.
        // Forcing pathIndices[0] = 2 violates pathIndices[i] * (1 - pathIndices[i]) === 0,
        // so witness/proof generation must fail.
        let threw = false;
        try {
            await realProof({ pathIndices: [2, 0, 0, 0] });
        } catch (err) {
            threw = true;
        }
        expect(threw, "fullProve should fail for a non-boolean pathIndices value").to.equal(true);
    });

    it("accepts a real proof end-to-end and tallies the vote (new 4-signal shape)", async function () {
        const { votingTally } = await loadFixture(deployRealVerifierFixture);
        const { input, proof, publicSignals } = await realProof({}, { voteIndex: 3 });

        const now = await time.latest();
        await votingTally.configureElection(BigInt(input.root_in), now - 1, now + 3600);

        const fp = h.formatProofForSolidity(proof);
        await expect(votingTally.submitTally(fp.a, fp.b, fp.c, publicSignals))
            .to.emit(votingTally, "VoteCast")
            .withArgs(ELECTION_ID, 3);

        expect(await votingTally.voteCounts(3)).to.equal(1);
    });

    it("rejects a real proof generated for a different election_id (audit C1)", async function () {
        const { votingTally } = await loadFixture(deployRealVerifierFixture);

        // Build the tree/root for the legitimate election, but prove a DIFFERENT
        // election_id. The Groth16 proof itself is valid, yet the on-chain
        // electionId binding must reject it.
        const { input } = await h.buildCircuitInput({
            depth: DEPTH,
            candidates: CANDIDATES,
            secret: SECRET,
            electionId: 999n,
            voteIndex: 1,
        });
        const { proof, publicSignals } = await h.fullProve(input, DEPTH, CANDIDATES);

        const now = await time.latest();
        await votingTally.configureElection(BigInt(input.root_in), now - 1, now + 3600);

        const fp = h.formatProofForSolidity(proof);
        // The proof verifies cryptographically, so this fails specifically on the
        // election-id binding, not on verifyProof.
        expect(await h.verifyProof(publicSignals, proof, DEPTH, CANDIDATES)).to.equal(true);
        await expect(votingTally.submitTally(fp.a, fp.b, fp.c, publicSignals))
            .to.be.revertedWith("VotingTally: Invalid election id");
    });
});

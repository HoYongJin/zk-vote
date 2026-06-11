const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");

describe("VotingTally", function () {
    const ELECTION_ID = 123n;
    const NUM_CANDIDATES = 3;

    // Public signal layout: [root, vote_index, nullifier_hash, election_id].
    function publicInputs({ root = 1, candidate = 0, nullifier = 777, electionId = ELECTION_ID } = {}) {
        return [root, candidate, nullifier, electionId];
    }

    function emptyProof() {
        return {
            a: [0, 0],
            b: [[0, 0], [0, 0]],
            c: [0, 0],
        };
    }

    async function deployVotingTallyFixture() {
        const [owner, otherAccount] = await ethers.getSigners();

        const VotingTally = await ethers.getContractFactory("VotingTally");
        const votingTally = await VotingTally.deploy(
            otherAccount.address,
            ELECTION_ID,
            NUM_CANDIDATES,
            owner.address
        );
        await votingTally.waitForDeployment();

        return { votingTally, owner, otherAccount, electionId: ELECTION_ID, numCandidates: NUM_CANDIDATES };
    }

    // Deploys a configured election backed by a MockVerifier so the full
    // submitTally path (including verifyProof) can be exercised.
    async function deployConfiguredWithMockFixture() {
        const [owner, otherAccount] = await ethers.getSigners();

        const MockVerifier = await ethers.getContractFactory("MockVerifier");
        const mockVerifier = await MockVerifier.deploy();
        await mockVerifier.waitForDeployment();

        const VotingTally = await ethers.getContractFactory("VotingTally");
        const votingTally = await VotingTally.deploy(
            await mockVerifier.getAddress(),
            ELECTION_ID,
            NUM_CANDIDATES,
            owner.address
        );
        await votingTally.waitForDeployment();

        const now = await time.latest();
        const merkleRoot = 1;
        await votingTally.configureElection(merkleRoot, now - 1, now + 3600);

        return {
            votingTally,
            mockVerifier,
            owner,
            otherAccount,
            merkleRoot,
            electionId: ELECTION_ID,
            numCandidates: NUM_CANDIDATES,
        };
    }

    describe("Deployment", function () {
        it("sets immutable election configuration", async function () {
            const { votingTally, owner, otherAccount, electionId, numCandidates } = await loadFixture(deployVotingTallyFixture);

            expect(await votingTally.owner()).to.equal(owner.address);
            expect(await votingTally.verifier()).to.equal(otherAccount.address);
            expect(await votingTally.electionId()).to.equal(electionId);
            expect(await votingTally.numCandidates()).to.equal(numCandidates);
        });
    });

    describe("Admin configuration", function () {
        it("keeps onlyOwner rights off the deploying relayer key (AR-M4)", async function () {
            // The hot relayer key DEPLOYS contracts but must hold no owner
            // privileges: a leaked relayer key must not be able to front-run
            // configureElection with an attacker-controlled Merkle root.
            const [relayer, , ownerAccount] = await ethers.getSigners();
            const VotingTally = await ethers.getContractFactory("VotingTally", relayer);
            const votingTally = await VotingTally.deploy(
                relayer.address, // verifier placeholder
                ELECTION_ID,
                NUM_CANDIDATES,
                ownerAccount.address
            );
            await votingTally.waitForDeployment();

            const now = await time.latest();
            await expect(
                votingTally.connect(relayer).configureElection(1, now - 1, now + 3600)
            ).to.be.revertedWith("VotingTally: Caller is not the owner");
            await expect(
                votingTally.connect(ownerAccount).configureElection(1, now - 1, now + 3600)
            ).to.not.be.reverted;
        });

        it("rejects zero owner, zero verifier, and zero candidates at deployment", async function () {
            const [deployer] = await ethers.getSigners();
            const VotingTally = await ethers.getContractFactory("VotingTally");
            await expect(
                VotingTally.deploy(ethers.ZeroAddress, ELECTION_ID, NUM_CANDIDATES, deployer.address)
            ).to.be.revertedWith("VotingTally: Verifier cannot be zero address");
            await expect(
                VotingTally.deploy(deployer.address, ELECTION_ID, NUM_CANDIDATES, ethers.ZeroAddress)
            ).to.be.revertedWith("VotingTally: Owner cannot be zero address");
            await expect(
                VotingTally.deploy(deployer.address, ELECTION_ID, 0, deployer.address)
            ).to.be.revertedWith("VotingTally: Candidates must be positive");
        });

        it("allows only the owner to set the Merkle root", async function () {
            const { votingTally, otherAccount } = await loadFixture(deployVotingTallyFixture);

            await expect(votingTally.connect(otherAccount).setMerkleRoot(1))
                .to.be.revertedWith("VotingTally: Caller is not the owner");
            await expect(votingTally.setMerkleRoot(0))
                .to.be.revertedWith("VotingTally: Merkle root cannot be zero");

            await votingTally.setMerkleRoot(1);
            expect(await votingTally.merkleRoot()).to.equal(1);
            await expect(votingTally.setMerkleRoot(2))
                .to.be.revertedWith("VotingTally: Merkle root already set");
        });

        it("requires a valid voting period", async function () {
            const { votingTally, otherAccount } = await loadFixture(deployVotingTallyFixture);
            const now = await time.latest();

            await expect(votingTally.connect(otherAccount).setVotingPeriod(now, now + 60))
                .to.be.revertedWith("VotingTally: Caller is not the owner");
            await expect(votingTally.setVotingPeriod(now, now + 60))
                .to.be.revertedWith("VotingTally: Merkle root is not set");
            await votingTally.setMerkleRoot(1);
            await expect(votingTally.setVotingPeriod(now + 60, now))
                .to.be.revertedWith("VotingTally: Start time must be before end time");

            await votingTally.setVotingPeriod(now, now + 60);
            expect(await votingTally.votingStartTime()).to.equal(now);
            expect(await votingTally.votingEndTime()).to.equal(now + 60);
            expect(await votingTally.configured()).to.equal(true);
            await expect(votingTally.setVotingPeriod(now, now + 120))
                .to.be.revertedWith("VotingTally: Election already configured");
        });

        it("atomically configures the Merkle root and voting period once", async function () {
            const { votingTally, otherAccount } = await loadFixture(deployVotingTallyFixture);
            const now = await time.latest();

            await expect(votingTally.connect(otherAccount).configureElection(1, now, now + 60))
                .to.be.revertedWith("VotingTally: Caller is not the owner");
            await expect(votingTally.configureElection(0, now, now + 60))
                .to.be.revertedWith("VotingTally: Merkle root cannot be zero");
            await expect(votingTally.configureElection(1, now + 60, now))
                .to.be.revertedWith("VotingTally: Start time must be before end time");

            await votingTally.configureElection(1, now, now + 60);
            expect(await votingTally.merkleRoot()).to.equal(1);
            expect(await votingTally.votingStartTime()).to.equal(now);
            expect(await votingTally.votingEndTime()).to.equal(now + 60);
            expect(await votingTally.configured()).to.equal(true);

            await expect(votingTally.configureElection(1, now, now + 120))
                .to.be.revertedWith("VotingTally: Election already configured");
            await expect(votingTally.setMerkleRoot(2))
                .to.be.revertedWith("VotingTally: Election already configured");
        });
    });

    describe("Vote submission guards (pre-verifier)", function () {
        it("rejects proofs with the wrong Merkle root before calling the verifier", async function () {
            const { votingTally } = await loadFixture(deployConfiguredWithMockFixture);
            const proof = emptyProof();

            await expect(votingTally.submitTally(proof.a, proof.b, proof.c, publicInputs({ root: 2 })))
                .to.be.revertedWith("VotingTally: Invalid Merkle root");
        });

        it("rejects proofs whose election id does not match this election (audit C1)", async function () {
            const { votingTally } = await loadFixture(deployConfiguredWithMockFixture);
            const proof = emptyProof();

            await expect(votingTally.submitTally(proof.a, proof.b, proof.c, publicInputs({ electionId: 999n })))
                .to.be.revertedWith("VotingTally: Invalid election id");
        });

        it("rejects out-of-range candidate indices before calling the verifier", async function () {
            const { votingTally, numCandidates } = await loadFixture(deployConfiguredWithMockFixture);
            const proof = emptyProof();

            await expect(votingTally.submitTally(proof.a, proof.b, proof.c, publicInputs({ candidate: numCandidates })))
                .to.be.revertedWith("VotingTally: Invalid candidate index");
        });
    });

    describe("Vote submission with MockVerifier", function () {
        it("accepts a valid vote, increments the tally, and emits VoteCast", async function () {
            const { votingTally, electionId } = await loadFixture(deployConfiguredWithMockFixture);
            const proof = emptyProof();
            const candidate = 1;

            await expect(votingTally.submitTally(proof.a, proof.b, proof.c, publicInputs({ candidate, nullifier: 555 })))
                .to.emit(votingTally, "VoteCast")
                .withArgs(electionId, candidate);

            expect(await votingTally.voteCounts(candidate)).to.equal(1);
            expect(await votingTally.usedNullifiers(555)).to.equal(true);
        });

        it("rejects a second vote that reuses the same nullifier", async function () {
            const { votingTally } = await loadFixture(deployConfiguredWithMockFixture);
            const proof = emptyProof();

            await votingTally.submitTally(proof.a, proof.b, proof.c, publicInputs({ candidate: 0, nullifier: 777 }));

            // Same nullifier, different candidate → still rejected.
            await expect(votingTally.submitTally(proof.a, proof.b, proof.c, publicInputs({ candidate: 2, nullifier: 777 })))
                .to.be.revertedWith("VotingTally: This vote has already been cast");
        });

        it("rejects the vote when the verifier returns false", async function () {
            const { votingTally, mockVerifier } = await loadFixture(deployConfiguredWithMockFixture);
            const proof = emptyProof();

            await mockVerifier.setResult(false);

            await expect(votingTally.submitTally(proof.a, proof.b, proof.c, publicInputs({ nullifier: 12345 })))
                .to.be.revertedWith("VotingTally: Invalid ZK proof");

            // A rejected proof must not consume a nullifier or move the tally.
            expect(await votingTally.usedNullifiers(12345)).to.equal(false);
            expect(await votingTally.voteCounts(0)).to.equal(0);
        });
    });
});

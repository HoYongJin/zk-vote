const { expect } = require("chai");
const {
    checksum,
    deriveElectionState,
    isDecimalFieldElementString,
    sourceOrderForTable,
    ELECTION_CHECKSUM_KEYS,
    VOTER_CHECKSUM_KEYS,
} = require("../scripts/migration/etl-supabase-to-postgres");

describe("cutover ETL checksums", function () {
    it("uses deterministic source pagination order for every migrated table", function () {
        expect(sourceOrderForTable("Elections")).to.equal("id");
        expect(sourceOrderForTable("Voters")).to.equal("id");
        expect(sourceOrderForTable("Admins")).to.equal("id");
        expect(sourceOrderForTable("AdminInvitations")).to.equal("email");
        expect(() => sourceOrderForTable("UnknownTable")).to.throw(
            "No deterministic source order configured"
        );
    });

    it("covers every migrated election field with canonical JSON/date handling", function () {
        const source = [{
            id: "00000000-0000-0000-0000-000000000001",
            name: "Election",
            merkle_tree_depth: 4,
            num_candidates: 2,
            candidates: ["Alice", "Bob"],
            registration_start_time: "2026-06-12T00:00:00.000Z",
            registration_end_time: "2026-06-13T00:00:00.000Z",
            voting_start_time: null,
            voting_end_time: null,
            merkle_root: null,
            contract_address: null,
            verifier_address: null,
            superseded_at: null,
            completed: false,
        }];
        const target = [{
            ...source[0],
            candidates: JSON.stringify(source[0].candidates),
            registration_start_time: new Date(source[0].registration_start_time),
            registration_end_time: new Date(source[0].registration_end_time),
        }];

        expect(checksum(target, ELECTION_CHECKSUM_KEYS)).to.equal(
            checksum(source, ELECTION_CHECKSUM_KEYS)
        );

        const changed = [{ ...source[0], num_candidates: 3 }];
        expect(checksum(changed, ELECTION_CHECKSUM_KEYS)).to.not.equal(
            checksum(source, ELECTION_CHECKSUM_KEYS)
        );

        const superseded = [{
            ...source[0],
            state: "failed",
            superseded_at: "2026-06-12T12:00:00.000Z",
        }];
        expect(checksum(superseded, ELECTION_CHECKSUM_KEYS)).to.not.equal(
            checksum(source, ELECTION_CHECKSUM_KEYS)
        );
    });

    it("normalizes superseded_at dates when comparing source and target rows", function () {
        const source = [{
            id: "00000000-0000-0000-0000-000000000002",
            state: "failed",
            name: "Superseded Election",
            merkle_tree_depth: 4,
            num_candidates: 2,
            candidates: ["Alice", "Bob"],
            registration_start_time: "2026-06-12T00:00:00.000Z",
            registration_end_time: "2026-06-13T00:00:00.000Z",
            voting_start_time: null,
            voting_end_time: null,
            merkle_root: null,
            contract_address: null,
            verifier_address: null,
            superseded_at: "2026-06-12T12:00:00.000Z",
            completed: false,
        }];
        const target = [{
            ...source[0],
            registration_start_time: new Date(source[0].registration_start_time),
            registration_end_time: new Date(source[0].registration_end_time),
            superseded_at: new Date(source[0].superseded_at),
        }];

        expect(checksum(target, ELECTION_CHECKSUM_KEYS)).to.equal(
            checksum(source, ELECTION_CHECKSUM_KEYS)
        );
    });

    it("covers voter names as well as identity and commitment fields", function () {
        const source = [{
            id: "00000000-0000-0000-0000-000000000101",
            election_id: "00000000-0000-0000-0000-000000000001",
            email: "voter@example.com",
            user_id: "00000000-0000-0000-0000-000000000201",
            name: "Voter",
            user_secret: "123",
        }];
        const changed = [{ ...source[0], name: "Different Voter" }];

        expect(checksum(changed, VOTER_CHECKSUM_KEYS)).to.not.equal(
            checksum(source, VOTER_CHECKSUM_KEYS)
        );
    });

    it("does not let delimiter-like field values collide in checksums", function () {
        const keys = ["left", "right"];
        const rowA = [{ left: "x|right=y", right: "z" }];
        const rowB = [{ left: "x", right: "y|right=z" }];

        expect(checksum(rowA, keys)).to.not.equal(checksum(rowB, keys));
    });

    it("requires ETL field elements to match the decimal-only target schema", function () {
        expect(isDecimalFieldElementString("123")).to.equal(true);
        expect(isDecimalFieldElementString("0x7b")).to.equal(false);
        expect(isDecimalFieldElementString("-1")).to.equal(false);
        expect(isDecimalFieldElementString(
            "21888242871839275222246405745257275088548364400416034343698204186575808495617"
        )).to.equal(false);
    });

    it("derives canonical target states from migrated Node fields", function () {
        const now = new Date("2026-06-12T12:00:00.000Z");

        expect(deriveElectionState({
            registration_end_time: "2026-06-13T00:00:00.000Z",
        }, now)).to.equal("registration_open");
        expect(deriveElectionState({
            contract_address: "0xabc",
            registration_end_time: "2026-06-13T00:00:00.000Z",
        }, now)).to.equal("contract_deployed");
        expect(deriveElectionState({
            merkle_root: "42",
            voting_start_time: "2026-06-12T11:00:00.000Z",
            voting_end_time: "2026-06-12T13:00:00.000Z",
        }, now)).to.equal("voting_active");
        expect(deriveElectionState({
            completed: true,
        }, now)).to.equal("completed");
        expect(deriveElectionState({
            superseded_at: "2026-06-12T11:00:00.000Z",
            completed: true,
        }, now)).to.equal("failed");
    });
});

const { expect } = require("chai");
const {
    buildTicketPayload,
    consumeSubmissionTicket,
    issueSubmissionTicket,
    readSubmissionTicket,
    ticketKey,
} = require("../server/utils/submissionTickets");

class FakeRedis {
    constructor() {
        this.store = new Map();
    }

    async set(key, value) {
        this.store.set(key, value);
        return "OK";
    }

    async getdel(key) {
        const value = this.store.get(key) || null;
        this.store.delete(key);
        return value;
    }

    async get(key) {
        return this.store.get(key) || null;
    }
}

describe("submissionTickets", function () {
    it("normalizes required ticket payload fields", function () {
        const payload = buildTicketPayload({
            electionId: "election-1",
            merkleRoot: 123n,
            nullifierHash: 456n,
        });

        expect(payload.electionId).to.equal("election-1");
        expect(payload.merkleRoot).to.equal("123");
        expect(payload.nullifierHash).to.equal("456");
        expect(payload.issuedAt).to.be.a("string");
    });

    it("allows tickets without nullifier binding for client-held-secret privacy", function () {
        const payload = buildTicketPayload({
            electionId: "election-1",
            merkleRoot: 123n,
        });

        expect(payload.electionId).to.equal("election-1");
        expect(payload.merkleRoot).to.equal("123");
        expect(payload).to.not.have.property("nullifierHash");
        expect(payload.issuedAt).to.be.a("string");
    });

    it("issues and consumes a single-use ticket", async function () {
        const client = new FakeRedis();
        const ticket = await issueSubmissionTicket(
            { electionId: "election-1", merkleRoot: "123", nullifierHash: "456" },
            { client, ticket: "fixed-ticket" }
        );

        expect(ticket).to.equal("fixed-ticket");
        expect(client.store.has(ticketKey(ticket))).to.equal(true);

        const peeked = await readSubmissionTicket(ticket, { client });
        expect(peeked).to.include({
            electionId: "election-1",
            merkleRoot: "123",
            nullifierHash: "456",
        });
        expect(client.store.has(ticketKey(ticket))).to.equal(true);

        const payload = await consumeSubmissionTicket(ticket, { client });
        expect(payload).to.include({
            electionId: "election-1",
            merkleRoot: "123",
            nullifierHash: "456",
        });

        const replay = await consumeSubmissionTicket(ticket, { client });
        expect(replay).to.equal(null);
    });

    it("returns null for missing tickets", async function () {
        const client = new FakeRedis();

        const payload = await consumeSubmissionTicket("missing-ticket", { client });

        expect(payload).to.equal(null);
    });
});

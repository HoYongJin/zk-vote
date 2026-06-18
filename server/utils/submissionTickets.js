const crypto = require("crypto");

const TICKET_EXPIRY_SECONDS = 300;
const getDefaultRedis = () => require("../redisClient");

function ticketKey(ticket) {
    return `submission-ticket:${ticket}`;
}

function normalizeField(value) {
    return value === undefined || value === null ? null : value.toString();
}

function ticketPayloadError(message) {
    return Object.assign(new Error(message), {
        code: "INVALID_TICKET_PAYLOAD",
        status: 403,
    });
}

function buildTicketPayload({ electionId, merkleRoot, nullifierHash }) {
    const normalizedElectionId = normalizeField(electionId);
    const normalizedMerkleRoot = normalizeField(merkleRoot);

    if (!normalizedElectionId || normalizedMerkleRoot === null) {
        throw new Error("Ticket payload requires electionId and merkleRoot.");
    }
    if (nullifierHash !== undefined && nullifierHash !== null) {
        throw ticketPayloadError("Ticket payload must not include nullifierHash.");
    }

    return {
        electionId: normalizedElectionId,
        merkleRoot: normalizedMerkleRoot,
        issuedAt: new Date().toISOString(),
    };
}

async function issueSubmissionTicket(payload, {
    client = getDefaultRedis(),
    ttlSeconds = TICKET_EXPIRY_SECONDS,
    ticket = crypto.randomUUID(),
} = {}) {
    const normalizedPayload = buildTicketPayload(payload);
    await client.set(ticketKey(ticket), JSON.stringify(normalizedPayload), "EX", ttlSeconds);
    return ticket;
}

async function getAndDelete(client, key) {
    if (typeof client.getdel === "function") {
        return client.getdel(key);
    }
    if (typeof client.call === "function") {
        return client.call("GETDEL", key);
    }
    throw new Error("Redis client does not support GETDEL.");
}

function parseTicketPayload(rawPayload) {
    if (!rawPayload) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(rawPayload);
    } catch (err) {
        throw ticketPayloadError("Submission ticket payload is malformed.");
    }

    if (!payload.electionId || !payload.merkleRoot) {
        throw ticketPayloadError("Submission ticket payload is incomplete.");
    }
    if (payload.nullifierHash !== undefined && payload.nullifierHash !== null) {
        throw ticketPayloadError("Submission ticket payload must not include nullifierHash.");
    }

    return {
        electionId: payload.electionId.toString(),
        merkleRoot: payload.merkleRoot.toString(),
        issuedAt: payload.issuedAt,
    };
}

async function readSubmissionTicket(ticket, { client = getDefaultRedis() } = {}) {
    if (!ticket || typeof ticket !== "string") {
        return null;
    }

    if (typeof client.get !== "function") {
        throw new Error("Redis client does not support GET.");
    }

    const rawPayload = await client.get(ticketKey(ticket));
    return parseTicketPayload(rawPayload);
}

async function consumeSubmissionTicket(ticket, { client = getDefaultRedis() } = {}) {
    if (!ticket || typeof ticket !== "string") {
        return null;
    }

    const rawPayload = await getAndDelete(client, ticketKey(ticket));
    return parseTicketPayload(rawPayload);
}

module.exports = {
    TICKET_EXPIRY_SECONDS,
    buildTicketPayload,
    consumeSubmissionTicket,
    issueSubmissionTicket,
    readSubmissionTicket,
    ticketKey,
};

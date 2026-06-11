const redis = require("../redisClient");

function onchainConfiguredKey(electionId) {
    return `election:onchain_configured:${electionId}`;
}

async function markOnchainConfigured(electionId, payload) {
    try {
        await redis.set(onchainConfiguredKey(electionId), JSON.stringify({
            ...payload,
            markedAt: new Date().toISOString(),
        }));
    } catch (err) {
        console.warn(`[finalizationState] Failed to mark on-chain finalization for ${electionId}: ${err.message}`);
    }
}

async function isOnchainConfigured(electionId) {
    try {
        return Boolean(await redis.get(onchainConfiguredKey(electionId)));
    } catch (err) {
        console.warn(`[finalizationState] Failed to read on-chain finalization marker for ${electionId}: ${err.message}`);
        return false;
    }
}

module.exports = {
    isOnchainConfigured,
    markOnchainConfigured,
    onchainConfiguredKey,
};

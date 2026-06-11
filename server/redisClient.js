const Redis = require("ioredis");
require("dotenv").config();

const redisUrl = process.env.REDIS_URL;
const redisOptions = {
    maxRetriesPerRequest: 3
};

if (process.env.REDIS_TLS === "true" || (redisUrl && redisUrl.startsWith("rediss://"))) {
    redisOptions.tls = {};
}

const redis = redisUrl
    ? new Redis(redisUrl, redisOptions)
    : new Redis({
        ...redisOptions,
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: Number(process.env.REDIS_PORT || 6379)
    });

redis.on('connect', () => {
    console.log('Connected to Redis');
});

redis.on('error', (err) => {
    console.error('Redis Connection Error:', err);
});

module.exports = redis;

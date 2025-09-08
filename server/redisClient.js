const Redis = require("ioredis");
require("dotenv").config();

// .env 파일에서 연결 정보를 가져와 Redis 클라이언트 인스턴스를 생성합니다.
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    maxRetriesPerRequest: 3 // 연결 실패 시 재시도 횟수
});

redis.on('connect', () => {
    console.log('Connected to AWS ElastiCache for Redis');
});

redis.on('error', (err) => {
    console.error('Redis Connection Error:', err);
});

module.exports = redis;
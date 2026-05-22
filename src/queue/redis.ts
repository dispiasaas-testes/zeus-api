import { Redis } from 'ioredis';

// Se estiver no Docker, usará a variável de ambiente. Senão, usa o localhost.
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';

export const redisConnection = new Redis({
    host: REDIS_HOST,
    port: 6379,
    maxRetriesPerRequest: null,
});

redisConnection.on('connect', () => {
    console.log(`🔴 Conectado ao Redis em ${REDIS_HOST}`);
});

redisConnection.on('error', (err) => {
    console.error('❌ Erro no Redis:', err);
});
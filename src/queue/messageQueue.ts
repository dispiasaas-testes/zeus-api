import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from './redis';
import { getSession } from '../whatsapp/manager';
import { pool } from '../database';

interface MessagePayload {
    tenantId: string;
    number: string;
    text?: string;
    mediaUrl?: string;
    mediaType?: 'image' | 'video' | 'audio' | 'document';
    mimetype?: string;
    metadata?: {
        ip: string;
        region: string;
        date: string;
        time: string;
    };
}

export const messageQueue = new Queue<MessagePayload>('whatsapp-messages', {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000,
        },
        removeOnComplete: true,
    },
});

const getValidJid = async (sock: any, rawNumber: string): Promise<string | null> => {
    let [result] = await sock.onWhatsApp(rawNumber);
    if (result?.exists) return result.jid;

    if (rawNumber.startsWith('55') && (rawNumber.length === 12 || rawNumber.length === 13)) {
        const ddd = rawNumber.substring(2, 4);
        const numeroLocal = rawNumber.substring(4);
        
        let variacao = '';
        
        if (numeroLocal.length === 9) {
            variacao = `55${ddd}${numeroLocal.substring(1)}`;
        } else if (numeroLocal.length === 8) {
            variacao = `55${ddd}9${numeroLocal}`;
        }

        if (variacao) {
            let [resultVariacao] = await sock.onWhatsApp(variacao);
            if (resultVariacao?.exists) {
                console.log(`[Worker] Auto-Correção de Nono Dígito: ${rawNumber} -> ${variacao}`);
                return resultVariacao.jid;
            }
        }
    }
    return null;
};

const messageWorker = new Worker<MessagePayload>(
    'whatsapp-messages',
    async (job: Job<MessagePayload>) => {
        const { tenantId, number, text, mediaUrl, mediaType, mimetype, metadata } = job.data;
        const session = getSession(tenantId);

        if (!session || session.status !== 'CONNECTED') {
            throw new Error(`Sessão do tenant ${tenantId} não está conectada.`);
        }

        const validJid = await getValidJid(session.sock, number);
        
        if (!validJid) {
            console.error(`[Worker] ❌ Abortado: O número ${number} não possui WhatsApp ativo (Tenant: ${tenantId})`);
            return; 
        }
        
        let sentMsg;
        let contentStr = text || `[Mídia: ${mediaType}]`;

        try {
            if (mediaUrl && mediaType) {
                let messageContent: any = {};
                
                if (mediaType === 'image') messageContent = { image: { url: mediaUrl }, caption: text };
                else if (mediaType === 'video') messageContent = { video: { url: mediaUrl }, caption: text };
                else if (mediaType === 'audio') messageContent = { audio: { url: mediaUrl }, ptt: true }; 
                else if (mediaType === 'document') messageContent = { document: { url: mediaUrl }, mimetype: mimetype || 'application/pdf', fileName: text || 'documento' };

                sentMsg = await session.sock.sendMessage(validJid, messageContent);
                console.log(`[Worker] ✅ Mídia (${mediaType}) enviada para ${validJid} (Tenant: ${tenantId})`);
            } else if (text) {
                sentMsg = await session.sock.sendMessage(validJid, { text });
                console.log(`[Worker] ✅ Texto enviado para ${validJid} (Tenant: ${tenantId})`);
            }
        } catch (err: any) {
            console.error(`[Worker] ❌ Erro ao enviar mensagem para ${validJid} (Tenant: ${tenantId}):`, err.message);
            throw err;
        }

        // 🔥 LOG COMPLETO COM ID SESSÃO, DATA/HORA, IP E JID (SALVA NO BANCO)
        if (sentMsg?.key?.id && metadata) {
            try {
                await pool.query(
                    `INSERT INTO messages_log 
                    (tenant_id, remote_jid, message_id, direction, status, content, original_content, api_ip, api_region, event_date, event_time) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [
                        tenantId, 
                        validJid, // Salva o JID atual (futuro-prova)
                        sentMsg.key.id, 
                        'SENT_API', 
                        'SENT', 
                        contentStr, 
                        contentStr, 
                        metadata.ip, 
                        metadata.region, 
                        metadata.date, 
                        metadata.time
                    ]
                );
            } catch (dbErr: any) {
                console.error('[Worker] Falha ao registrar log de disparo:', dbErr.message);
            }
        }
    },
    { 
        connection: redisConnection,
        concurrency: 5 
    }
);

messageWorker.on('failed', (job, err) => {
    console.error(`[Worker] ❌ Falha ao enviar job ${job?.id}:`, err.message);
});
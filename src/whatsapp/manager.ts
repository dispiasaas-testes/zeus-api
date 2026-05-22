import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import axios from 'axios';
import { pool } from '../database';
import { usePostgresAuthState } from './postgresAuth';

const sessions = new Map<string, any>();
const logger = pino({ level: 'silent' });

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3333/api/webhook'; 

// Função auxiliar para data e hora no padrão brasileiro
const getBrDateTime = () => {
    const now = new Date();
    return {
        date: now.toLocaleDateString('pt-BR'),
        time: now.toLocaleTimeString('pt-BR')
    };
};

export const initTenantSession = async (tenantId: string) => {
    const { state, saveCreds, removeCreds } = await usePostgresAuthState(tenantId, pool);
    
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[${tenantId}] Inicializando com WA v${version.join('.')} via PostgreSQL`);

    // Limpa a sessão antiga da memória (Evita Memory Leak)
    if (sessions.has(tenantId)) {
        const oldSession = sessions.get(tenantId);
        if (oldSession?.sock) {
            oldSession.sock.end(undefined);
        }
        sessions.delete(tenantId);
    }

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger,
        // 🔥 ALTERAÇÃO AQUI:
        browser: ['Zeus-API', 'Chrome', '1.0.0'], 
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`[${tenantId}] Novo QR Code gerado`);
            sessions.set(tenantId, { ...sessions.get(tenantId), sock, qrCode: qr, status: 'WAITING_QR' });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[${tenantId}] Conexão fechada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);
            
            // Destrói o socket atual antes de tentar reconectar
            sock.end(undefined);

            if (shouldReconnect) {
                setTimeout(() => initTenantSession(tenantId), 5000); // Aumentado para 5s para evitar rate limit
            } else {
                await removeCreds();
                sessions.delete(tenantId);
                console.log(`[${tenantId}] Sessão encerrada e dados apagados do PostgreSQL.`);
            }
        } else if (connection === 'open') {
            console.log(`[${tenantId}] Conectado com sucesso!`);
            sessions.set(tenantId, { sock, status: 'CONNECTED', qrCode: null });
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // 🔥 EVENTOS: CAPTURA DE LEITURA E ENTREGA (STATUS)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            const msgId = update.key.id;
            let statusStr = '';

            // Mapeia os status do Baileys para texto
            if (update.update.status === 2) statusStr = 'RECEIVED_BY_SERVER'; // Sent
            if (update.update.status === 3) statusStr = 'DELIVERED'; // Entregue
            if (update.update.status === 4) statusStr = 'READ'; // Lido/Reproduzido

            if (statusStr && msgId) {
                try {
                    await pool.query(
                        `UPDATE messages_log SET status = $1 WHERE tenant_id = $2 AND message_id = $3`,
                        [statusStr, tenantId, msgId]
                    );
                } catch (error) {}
            }
        }
    });

    // 🔥 EVENTOS: RECEBIMENTO, EDIÇÃO E EXCLUSÃO
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                const remoteJid = msg.key.remoteJid;
                const messageId = msg.key.id;
                const messageObj = msg.message;
                const { date, time } = getBrDateTime();
                
                if (!messageObj || !remoteJid || !messageId) continue;

                // 1. DETECÇÃO DE MENSAGEM APAGADA PARA TODOS (REVOKE)
                if (messageObj.protocolMessage?.type === 0 || messageObj.protocolMessage?.type === 14) {
                    const deletedMsgId = messageObj.protocolMessage.key?.id;
                    if (deletedMsgId) {
                        console.log(`[${tenantId}] 🗑️ Mensagem Apagada: ${deletedMsgId}`);
                        await pool.query(
                            `UPDATE messages_log SET is_deleted = TRUE WHERE tenant_id = $1 AND message_id = $2`,
                            [tenantId, deletedMsgId]
                        );
                    }
                    continue;
                }

                // 2. DETECÇÃO DE MENSAGEM EDITADA
                if (messageObj.editedMessage) {
                    const editedMsgId = messageObj.protocolMessage?.key?.id;
                    const newContent = messageObj.editedMessage.message?.protocolMessage?.editedMessage?.conversation || 
                                       messageObj.editedMessage.message?.extendedTextMessage?.text || '[Edição Complexa]';
                    
                    if (editedMsgId) {
                        console.log(`[${tenantId}] ✏️ Mensagem Editada: ${editedMsgId} -> ${newContent}`);
                        await pool.query(
                            `UPDATE messages_log SET is_edited = TRUE, content = $1 WHERE tenant_id = $2 AND message_id = $3`,
                            [newContent, tenantId, editedMsgId]
                        );
                    }
                    continue;
                }

                // Ignora mensagens enviadas por nós mesmos se não for edição/deleção
                if (msg.key.fromMe || remoteJid === 'status@broadcast') continue;

                const messageType = Object.keys(messageObj)[0];
                let content = '';

                if (messageType === 'conversation') content = messageObj.conversation || '';
                else if (messageType === 'extendedTextMessage') content = messageObj.extendedTextMessage?.text || '';
                else if (messageType === 'imageMessage') content = '[Imagem]';
                else if (messageType === 'videoMessage') content = '[Vídeo]';
                else if (messageType === 'audioMessage') content = '[Áudio]';
                else if (messageType === 'documentMessage') content = '[Documento]';
                else if (messageType === 'stickerMessage') content = '[Figurinha]';
                else content = `[Outro Formato: ${messageType}]`;

                console.log(`[${tenantId}] 📩 Nova mensagem de ${remoteJid}: ${content}`);

                // Grava a mensagem recebida no banco perpétuo
                try {
                    await pool.query(
                        `INSERT INTO messages_log 
                        (tenant_id, remote_jid, message_id, direction, status, content, original_content, api_ip, api_region, event_date, event_time) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        ON CONFLICT DO NOTHING`,
                        [tenantId, remoteJid, messageId, 'RECEIVED_WA', 'DELIVERED', content, content, 'Rede WhatsApp (E2E)', 'N/A', date, time]
                    );
                } catch (dbErr) {}

                try {
                    await axios.post(WEBHOOK_URL, {
                        tenantId,
                        from: remoteJid,
                        pushName: msg.pushName || 'Desconhecido',
                        messageType,
                        content,
                        timestamp: msg.messageTimestamp,
                        isGroup: remoteJid?.endsWith('@g.us')
                    });
                } catch (error: any) {}
            }
        }
    });

    if (!sessions.has(tenantId)) {
        sessions.set(tenantId, { sock, status: 'INITIALIZING', qrCode: null });
    }

    return sock;
};

export const getSession = (tenantId: string) => sessions.get(tenantId);

export const getAllSessions = () => {
    return Array.from(sessions.entries()).map(([id, data]) => ({
        tenantId: id,
        status: data.status
    }));
};

export const loadAllSessionsFromDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessions_v2 (
                tenant_id VARCHAR(255) NOT NULL,
                key_id TEXT NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (tenant_id, key_id)
            );
        `);

        const { rows } = await pool.query("SELECT DISTINCT tenant_id FROM whatsapp_sessions_v2 WHERE key_id = 'creds'");

        console.log(`[Autoboot] Encontradas ${rows.length} sessões prontas para restauração no PostgreSQL.`);

        for (const row of rows) {
            console.log(`[Autoboot] Restaurando conexão automática para o Tenant: ${row.tenant_id}`);
            initTenantSession(row.tenant_id).catch(err => {
                console.error(`[Autoboot] Erro ao restaurar o tenant ${row.tenant_id}:`, err.message);
            });
        }
    } catch (error: any) {
        console.error('[Autoboot] Erro ao ler sessões do banco de dados:', error.message);
    }
};

export const generatePairingCode = async (tenantId: string, phoneNumber: string) => {
    const session = sessions.get(tenantId);
    
    if (!session || !session.sock) throw new Error('Sessão não encontrada ou ainda não inicializada.');

    const cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') || cleanNumber.length < 12) {
        throw new Error('Número inválido. Certifique-se de incluir o DDI (55) e o DDD.');
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
    const code = await session.sock.requestPairingCode(cleanNumber);
    return code;
};
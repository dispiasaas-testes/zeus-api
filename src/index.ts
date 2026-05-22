// @ts-nocheck
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { initTenantSession, getSession, getAllSessions, loadAllSessionsFromDatabase, generatePairingCode } from './whatsapp/manager';
import qrcode from 'qrcode';
import { messageQueue } from './queue/messageQueue';
import { apiKeyAuth } from './middleware/auth';
import { pool, initializeDatabase } from './database';
import crypto from 'crypto';
import axios from 'axios';
import swaggerUi from 'swagger-ui-express';
import swaggerJsDoc from 'swagger-jsdoc';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ==========================================
// CONFIGURAÇÃO DO SWAGGER (À Prova de Falhas)
// ==========================================
const swaggerOptions = {
    swaggerDefinition: {
        openapi: '3.0.0',
        info: {
            title: 'SaaS WhatsApp API Gateway',
            version: '1.0.0',
            description: 'Painel unificado para manutenção, testes rápidos e gerenciamento de instâncias multitenant.',
        },
        // 🔥 CORREÇÃO: Adicionado o IP da AWS para o botão "Execute" funcionar no navegador
        servers: [
            { url: 'http://3.144.93.205:3000', description: 'Servidor AWS (Produção)' },
            { url: 'http://localhost:3000', description: 'Servidor Local / Desenvolvimento' }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'API Key ou Master Key',
                }
            }
        },
        security: [{ bearerAuth: [] }],
        paths: {
            '/api/v1/admin/tenants': {
                post: {
                    summary: 'Criar uma nova instância de Tenant',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['tenantId'],
                                    properties: { tenantId: { type: 'string', example: 'cliente_1' } }
                                }
                            }
                        }
                    },
                    responses: { 200: { description: 'Instância criada com sucesso e chave gerada.' } }
                }
            },
            '/api/v1/sessions/{tenantId}/pairing-code': {
                post: {
                    summary: 'Solicitar Código PIN',
                    parameters: [{ in: 'path', name: 'tenantId', required: true, schema: { type: 'string' } }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['phoneNumber'],
                                    properties: { phoneNumber: { type: 'string', example: '5541999999999' } }
                                }
                            }
                        }
                    },
                    responses: { 200: { description: 'Código PIN gerado' } }
                }
            },
            '/api/v1/sessions/{tenantId}/messages': {
                post: {
                    summary: 'Disparar Mensagem (Texto/Mídia)',
                    parameters: [{ in: 'path', name: 'tenantId', required: true, schema: { type: 'string' } }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['number'],
                                    properties: {
                                        number: { type: 'string', example: '5541999999999' },
                                        text: { type: 'string', example: 'Olá! Mensagem da API.' },
                                        mediaUrl: { type: 'string', example: 'https://exemplo.com/doc.pdf' },
                                        mediaType: { type: 'string', example: 'document', description: 'image, video, audio, document' }
                                    }
                                }
                            }
                        }
                    },
                    responses: { 200: { description: 'Mensagem adicionada à fila auditada' } }
                }
            },
            '/api/v1/sessions/{tenantId}': {
                get: {
                    summary: 'Interface de Conexão HTML (QR/PIN)',
                    parameters: [{ in: 'path', name: 'tenantId', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: 'Painel HTML Renderizado' } }
                },
                delete: {
                    summary: 'Desconectar Sessão (Logout)',
                    parameters: [{ in: 'path', name: 'tenantId', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: 'Desconectado e banco limpo' } }
                }
            },
            '/api/v1/sessions': {
                get: {
                    summary: 'Listar instâncias ativas na memória',
                    responses: { 200: { description: 'Lista retornada' } }
                }
            }
        }
    },
    apis: [],
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);

// 🔒 PROTEÇÃO DO SWAGGER
app.use('/api-docs', (req: Request, res: Response, next: NextFunction) => {
    if (req.url.includes('.css') || req.url.includes('.js') || req.url.includes('.png')) {
        return next();
    }

    const { key } = req.query;
    const masterKey = process.env.API_KEY;

    if (!masterKey) return res.status(500).send('Erro: API_KEY Master não configurada no .env');

    if (key === masterKey || req.headers.authorization?.includes(masterKey)) {
        next();
    } else {
        res.status(401).send('Acesso Negado: Forneça a Master Key correta na URL. Exemplo: /api-docs/?key=sua_master_key');
    }
}, swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// 🔒 Aplica o middleware global de segurança para todas as rotas da API v1
app.use('/api/v1', apiKeyAuth);

const getBrDateTime = () => {
    const now = new Date();
    return {
        date: now.toLocaleDateString('pt-BR'),
        time: now.toLocaleTimeString('pt-BR')
    };
};

const getIpLocation = async (ip: string): Promise<{ ip: string; region: string }> => {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.0.0.1')) {
        return { ip: '127.0.0.1 (Localhost)', region: 'Ambiente Local / Dev' };
    }

    const cleanIp = ip.replace('::ffff:', '');

    try {
        const response = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,regionName,city`);
        if (response.data && response.data.status === 'success') {
            return {
                ip: cleanIp,
                region: `${response.data.city}, ${response.data.regionName} - ${response.data.country}`
            };
        }
        return { ip: cleanIp, region: 'Região Não Identificada' };
    } catch (error) {
        return { ip: cleanIp, region: 'Falha no Provedor de Geolocalização' };
    }
};

// ==========================================
// ROTAS DA API
// ==========================================

app.post('/api/v1/admin/tenants', async (req: Request, res: Response) => {
    const { tenantId } = req.body;

    if (!tenantId) {
        return res.status(400).json({ error: 'O campo tenantId é obrigatório.' });
    }

    const newApiKey = 'sk_live_wa_' + crypto.randomBytes(16).toString('hex');

    try {
        await pool.query(
            `INSERT INTO api_keys (tenant_id, api_key) VALUES ($1, $2) 
             ON CONFLICT (tenant_id) DO UPDATE SET api_key = EXCLUDED.api_key`,
            [tenantId, newApiKey]
        );

        res.json({
            success: true,
            message: `Instância para o tenant '${tenantId}' criada com sucesso!`,
            tenantId: tenantId,
            apiKey: newApiKey
        });
    } catch (error: any) {
        res.status(500).json({ error: 'Erro ao gerar API Key', details: error.message });
    }
});

app.post('/api/v1/sessions/:tenantId/pairing-code', async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'O número de telefone é obrigatório.' });
    }

    try {
        let session = getSession(tenantId);
        if (!session) {
            await initTenantSession(tenantId);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const code = await generatePairingCode(tenantId, phoneNumber);
        res.json({ success: true, code });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Erro ao gerar o PIN.' });
    }
});

app.get('/api/v1/sessions/:tenantId', async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    const authToken = req.headers.authorization || '';
    
    let session = getSession(tenantId);

    if (!session) {
        await initTenantSession(tenantId);
        await new Promise(resolve => setTimeout(resolve, 1500));
        session = getSession(tenantId);
    }

    if (session?.status === 'WAITING_QR' && session.qrCode) {
        const qrBase64 = await qrcode.toDataURL(session.qrCode);
        
        const html = `
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Conectar - ${tenantId}</title>
                <style>
                    body { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #0f172a; color: #f8fafc; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                    .card { background: #1e293b; padding: 30px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; border: 1px solid #334155; width: 340px; }
                    h2 { margin-top: 0; color: #38bdf8; font-size: 1.5rem;}
                    .tabs { display: flex; margin-bottom: 20px; background: #0f172a; border-radius: 8px; padding: 4px; }
                    .tab { flex: 1; padding: 10px; cursor: pointer; border-radius: 6px; font-weight: 600; font-size: 0.9rem; transition: all 0.3s; }
                    .tab.active { background: #38bdf8; color: #0f172a; }
                    .section { display: none; }
                    .section.active { display: block; animation: fadeIn 0.4s ease; }
                    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
                    img.qr { border-radius: 12px; margin: 10px 0; border: 4px solid #fff; width: 240px; height: 240px; }
                    input { width: 90%; padding: 12px; margin: 15px 0; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; text-align: center; font-size: 1rem; outline: none; }
                    input:focus { border-color: #38bdf8; }
                    button.btn { width: 100%; background: #38bdf8; color: #0f172a; border: none; padding: 12px; border-radius: 8px; font-weight: bold; font-size: 1rem; cursor: pointer; transition: 0.2s; }
                    button.btn:hover { background: #0ea5e9; }
                    button.btn:disabled { background: #475569; cursor: not-allowed; }
                    .pin-display { margin-top: 20px; font-size: 1.2rem; color: #94a3b8; display: none; }
                    .pin-display span { display: block; margin-top: 10px; font-size: 2.2rem; font-weight: bold; color: #22c55e; letter-spacing: 6px; }
                    .status { font-weight: bold; color: #fbbf24; margin-top: 15px; font-size: 0.9rem; }
                    .footer { margin-top: 10px; font-size: 0.8rem; color: #64748b; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>Conectar Dispositivo</h2>
                    
                    <div class="tabs">
                        <div class="tab active" onclick="switchTab('qr')">QR Code</div>
                        <div class="tab" onclick="switchTab('pin')">Telefone (PIN)</div>
                    </div>

                    <div id="sec-qr" class="section active">
                        <img class="qr" src="${qrBase64}" alt="QR Code" />
                        <div class="status">Aguardando leitura...</div>
                        <div class="footer">A página recarrega em 15s.</div>
                    </div>

                    <div id="sec-pin" class="section">
                        <p style="font-size: 0.9rem; color: #cbd5e1; margin-bottom: 5px;">Digite o número que será conectado:</p>
                        <input type="text" id="phone" placeholder="Ex: 5541999999999" />
                        <button id="btn-pin" class="btn" onclick="requestPin()">Gerar Código PIN</button>
                        
                        <div id="pin-display" class="pin-display">
                            Seu código de acesso:
                            <span id="pin-code"></span>
                            <p style="font-size: 0.8rem; letter-spacing: 0; color: #cbd5e1; margin-top: 15px;">
                                O WhatsApp mostrará uma notificação no seu celular. Toque nela e digite este código.
                            </p>
                        </div>
                    </div>
                </div>

                <script>
                    const authToken = "${authToken}";
                    let refreshTimer = setTimeout(() => window.location.reload(), 15000);

                    function switchTab(tab) {
                        document.getElementById('sec-qr').classList.remove('active');
                        document.getElementById('sec-pin').classList.remove('active');
                        document.querySelectorAll('.tab')[0].classList.remove('active');
                        document.querySelectorAll('.tab')[1].classList.remove('active');
                        
                        if (tab === 'qr') {
                            document.getElementById('sec-qr').classList.add('active');
                            document.querySelectorAll('.tab')[0].classList.add('active');
                            refreshTimer = setTimeout(() => window.location.reload(), 15000);
                        } else {
                            document.getElementById('sec-pin').classList.add('active');
                            document.querySelectorAll('.tab')[1].classList.add('active');
                            clearTimeout(refreshTimer);
                        }
                    }

                    async function requestPin() {
                        const btn = document.getElementById('btn-pin');
                        const phone = document.getElementById('phone').value;
                        
                        if(!phone || phone.length < 12) {
                            alert('Digite um número válido com DDI e DDD. Ex: 5541999999999');
                            return;
                        }

                        btn.innerText = 'Gerando Código...';
                        btn.disabled = true;

                        try {
                            const response = await fetch('/api/v1/sessions/${tenantId}/pairing-code', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': authToken
                                },
                                body: JSON.stringify({ phoneNumber: phone })
                            });

                            const data = await response.json();
                            
                            if (data.success && data.code) {
                                const code = data.code;
                                const formattedCode = code.match(/.{1,4}/g).join('-');
                                
                                document.getElementById('pin-code').innerText = formattedCode;
                                document.getElementById('pin-display').style.display = 'block';
                                btn.style.display = 'none'; 
                                document.getElementById('phone').style.display = 'none'; 
                            } else {
                                alert('Erro: ' + (data.error || 'Falha desconhecida.'));
                                btn.innerText = 'Gerar Código PIN';
                                btn.disabled = false;
                            }
                        } catch (err) {
                            alert('Erro de comunicação com o servidor.');
                            btn.innerText = 'Gerar Código PIN';
                            btn.disabled = false;
                        }
                    }
                </script>
            </body>
            </html>
        `;
        return res.send(html);
    }

    if (session?.status === 'CONNECTED') {
        const htmlConnected = `
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <title>Conectado - ${tenantId}</title>
                <style>
                    body { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #0f172a; color: #f8fafc; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                    .card { background: #1e293b; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0, 255, 128, 0.1); text-align: center; border: 2px solid #22c55e; }
                    h2 { margin-top: 0; color: #22c55e; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>✅ Conexão Estabelecida</h2>
                    <p>O número para <strong>${tenantId}</strong> está autenticado e pronto para disparos.</p>
                </div>
            </body>
            </html>
        `;
        return res.send(htmlConnected);
    }

    res.json({ status: session?.status || 'UNKNOWN' });
});

app.post('/api/v1/sessions/:tenantId/messages', async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    const { number, text, mediaUrl, mediaType, mimetype } = req.body;

    const session = getSession(tenantId);
    
    if (!session || session.status !== 'CONNECTED') {
        return res.status(400).json({ error: 'Sessão não conectada ou inexistente para este tenant.' });
    }

    const clientRawIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
    const { ip, region } = await getIpLocation(clientRawIp);
    const { date, time } = getBrDateTime();

    try {
        const job = await messageQueue.add('send-message', {
            tenantId,
            number,
            text,
            mediaUrl,
            mediaType,
            mimetype,
            metadata: {
                ip,
                region,
                date,
                time
            }
        });

        res.json({ 
            success: true, 
            message: 'Mensagem adicionada com sucesso à fila de envio auditada.',
            jobId: job.id 
        });
    } catch (error: any) {
        res.status(500).json({ error: 'Erro ao enfileirar mensagem', details: error.message });
    }
});

app.delete('/api/v1/sessions/:tenantId', async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    const session = getSession(tenantId);

    if (session?.sock) {
        await session.sock.logout();
        res.json({ success: true, message: `Sessão do tenant '${tenantId}' encerrada com sucesso e dados limpos.` });
    } else {
        res.status(404).json({ error: 'Sessão não encontrada ou ativa para este cliente.' });
    }
});

app.get('/api/v1/sessions', async (req: Request, res: Response) => {
    try {
        const sessions = getAllSessions();
        const { rows } = await pool.query('SELECT tenant_id, api_key FROM api_keys');
        
        const result = sessions.map(sessionData => {
            const dbMatch = rows.find(r => r.tenant_id.trim() === sessionData.tenantId.trim());
            
            return {
                id: sessionData.tenantId, 
                status: sessionData.status,
                apiKey: dbMatch ? dbMatch.api_key : 'Chave não cadastrada'
            };
        });
        
        res.json(result);
    } catch (error) {
        console.error("Erro no GET /sessions:", error);
        res.status(500).json({ error: 'Erro ao listar instâncias' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Gateway rodando na porta ${PORT}`);
    
    await initializeDatabase();
    await loadAllSessionsFromDatabase();
});
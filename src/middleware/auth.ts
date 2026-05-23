import { Request, Response, NextFunction } from 'express';
import { pool } from '../database';
import 'dotenv/config';

export const apiKeyAuth = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Token não fornecido' });

    const token = authHeader.split(' ')[1];
    
    // LOG DE SEGURANÇA NO TERMINAL
    console.log(`[AUTH] Tentando acesso em: ${req.originalUrl}`);
    console.log(`[AUTH] Token recebido: ${token}`);

    try {
        if (token === process.env.API_KEY) {
            console.log("[AUTH] Master Key validada com sucesso.");
            return next();
        }

        const { rows } = await pool.query('SELECT tenant_id FROM api_keys WHERE api_key = $1', [token]);
        
        if (rows.length === 0) {
            console.log("[AUTH] Chave não encontrada no banco.");
            return res.status(403).json({ error: 'API Key inválida' });
        }

        const dbTenant = rows[0].tenant_id;
        const urlTenant = req.params.tenantId;

        console.log(`[AUTH] Comparando DB Tenant [${dbTenant}] vs URL Tenant [${urlTenant}]`);

        if (urlTenant && urlTenant !== dbTenant) {
            return res.status(403).json({ error: `Permissão negada. Você é dono de ${dbTenant}, não de ${urlTenant}` });
        }

        next();
    } catch (e) {
        res.status(500).json({ error: 'Erro no auth' });
    }
};
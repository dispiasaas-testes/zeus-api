import { initAuthCreds, BufferJSON, proto, SignalDataTypeMap, AuthenticationState } from '@whiskeysockets/baileys';
import { Pool } from 'pg';

export const usePostgresAuthState = async (tenantId: string, pool: Pool) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions_v2 (
            tenant_id VARCHAR(255) NOT NULL,
            key_id TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (tenant_id, key_id)
        );
    `);

    const writeData = async (data: any, keyId: string) => {
        const dataString = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(
            `INSERT INTO whatsapp_sessions_v2 (tenant_id, key_id, data) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, key_id) DO UPDATE SET data = EXCLUDED.data`,
            [tenantId, keyId, dataString]
        );
    };

    const readData = async (keyId: string) => {
        const { rows } = await pool.query(
            `SELECT data FROM whatsapp_sessions_v2 WHERE tenant_id = $1 AND key_id = $2`,
            [tenantId, keyId]
        );
        if (rows.length > 0) {
            return JSON.parse(rows[0].data, BufferJSON.reviver);
        }
        return null;
    };

    const removeData = async (keyId: string) => {
        await pool.query(`DELETE FROM whatsapp_sessions_v2 WHERE tenant_id = $1 AND key_id = $2`, [tenantId, keyId]);
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        // O casting 'as AuthenticationState' resolve o erro do compilador tsc
        state: {
            creds,
            keys: {
                get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
                    const data: { [key: string]: any } = {}; // Tipado como 'any' para evitar conflito de union types no build
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data: any) => {
                    const tasks: Promise<any>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        } as AuthenticationState,
        saveCreds: () => writeData(creds, 'creds'),
        removeCreds: async () => {
            await pool.query(`DELETE FROM whatsapp_sessions_v2 WHERE tenant_id = $1`, [tenantId]);
        }
    };
};
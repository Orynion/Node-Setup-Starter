const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');

// Load .env first, then override with .nexushost/nexushost.env if present
dotenv.config();
const nexusEnvPath = path.join(process.cwd(), '.nexushost', 'nexushost.env');
if (fs.existsSync(nexusEnvPath)) {
    dotenv.config({ path: nexusEnvPath, override: true });
}

const rawUrl = (
    process.env.TURSO_DATABASE_URL ||
    process.env.TURSO_URL ||
    process.env.DATABASE_URL ||
    process.env.LIBSQL_URL ||
    ''
).trim();

const rawToken = (
    process.env.TURSO_AUTH_TOKEN ||
    process.env.TURSO_TOKEN ||
    process.env.DATABASE_AUTH_TOKEN ||
    process.env.LIBSQL_AUTH_TOKEN ||
    ''
).trim();

const isRemoteTurso = Boolean(rawUrl && !rawUrl.startsWith('file:'));
const url = rawUrl || 'file:data.db';
const authToken = rawToken || undefined;

if (isRemoteTurso) {
    const maskedUrl = url.replace(/(:\/\/[^@]+@)/, '://***@');
    console.log(`[Database] Initializing remote Turso connection to: ${maskedUrl}`);
    if (!authToken) {
        console.warn('[Database] WARNING: Turso database URL provided without TURSO_AUTH_TOKEN. Connection may fail if authentication is required.');
    }
} else {
    console.warn('[Database] Notice: No remote Turso URL found in environment variables (TURSO_DATABASE_URL). Using local SQLite storage (file:data.db).');
}

const client = createClient(authToken ? { url, authToken } : { url });

const schema = `
    CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY,
        wallet_tokens REAL NOT NULL DEFAULT 0,
        portfolio TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS companies (
        ticker TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        ipo_share_price REAL NOT NULL,
        current_price REAL NOT NULL,
        total_supply INTEGER NOT NULL,
        shares_in_circulation INTEGER NOT NULL,
        bot_share_reserve INTEGER NOT NULL,
        pending_cashout_tokens REAL NOT NULL DEFAULT 0,
        all_time_earnings REAL NOT NULL DEFAULT 0,
        emoji TEXT NOT NULL DEFAULT '🏢'
    );

    CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        price REAL NOT NULL,
        timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sell_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id TEXT NOT NULL,
        ticker TEXT NOT NULL,
        shares INTEGER NOT NULL,
        list_price REAL NOT NULL,
        timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        buyer_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        shares INTEGER NOT NULL,
        trade_value REAL NOT NULL,
        fee_amount REAL NOT NULL,
        timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cashout_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        channel_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        admin_id TEXT,
        admin_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_trade_ledger_timestamp
        ON trade_ledger (timestamp);

    CREATE INDEX IF NOT EXISTS idx_cashout_requests_user
        ON cashout_requests (user_id);

    CREATE INDEX IF NOT EXISTS idx_cashout_requests_status
        ON cashout_requests (status);
`;

function toArgs(params) {
    if (params.length === 0) return [];
    if (params.length === 1 && Array.isArray(params[0])) return params[0];
    return params;
}

function createPreparedStatement(executor, sql) {
    return {
        async run(...params) {
            const args = toArgs(params);
            try {
                const result = await executor.execute({ sql, args });
                return {
                    changes: Number(result.rowsAffected ?? 0),
                    lastInsertRowid: result.lastInsertRowid,
                };
            } catch (err) {
                console.error(`[Database Error] run() failed for query: "${sql}" args: ${JSON.stringify(args)}:`, err.message);
                throw err;
            }
        },
        async get(...params) {
            const args = toArgs(params);
            try {
                const result = await executor.execute({ sql, args });
                return result.rows?.[0];
            } catch (err) {
                console.error(`[Database Error] get() failed for query: "${sql}" args: ${JSON.stringify(args)}:`, err.message);
                throw err;
            }
        },
        async all(...params) {
            const args = toArgs(params);
            try {
                const result = await executor.execute({ sql, args });
                return result.rows ?? [];
            } catch (err) {
                console.error(`[Database Error] all() failed for query: "${sql}" args: ${JSON.stringify(args)}:`, err.message);
                throw err;
            }
        },
    };
}

class TursoDatabase {
    constructor() {
        this.isRemote = isRemoteTurso;
        this.ready = this.initialize();
    }

    async initialize() {
        try {
            await client.executeMultiple(schema);
            try {
                await client.execute('ALTER TABLE companies ADD COLUMN all_time_earnings REAL NOT NULL DEFAULT 0');
            } catch (_) {}
            try {
                await client.execute("ALTER TABLE companies ADD COLUMN emoji TEXT NOT NULL DEFAULT '🏢'");
            } catch (_) {}
            console.log(`[Database] Database ready and verified (${this.isRemote ? 'Turso Cloud' : 'Local SQLite'}).`);
        } catch (err) {
            console.error('[Database] Database initialization note:', err.message);
        }
    }

    prepare(sql) {
        return createPreparedStatement(client, sql);
    }

    async transaction(callback) {
        await this.ready;
        const transaction = await client.transaction('write');
        const txDb = {
            prepare: sql => createPreparedStatement(transaction, sql),
        };

        try {
            const result = await callback(txDb);
            await transaction.commit();
            return result;
        } catch (error) {
            console.error('[Database Transaction Error]:', error.message);
            await transaction.rollback();
            throw error;
        }
    }
}

module.exports = new TursoDatabase();
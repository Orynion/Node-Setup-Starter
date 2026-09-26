const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || 'file:data.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

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

    CREATE INDEX IF NOT EXISTS idx_trade_ledger_timestamp
        ON trade_ledger (timestamp);
`;

function toArgs(params) {
    return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

function createPreparedStatement(executor, sql) {
    return {
        async run(...params) {
            const result = await executor.execute({ sql, args: toArgs(params) });
            return {
                changes: Number(result.rowsAffected ?? 0),
                lastInsertRowid: result.lastInsertRowid,
            };
        },
        async get(...params) {
            const result = await executor.execute({ sql, args: toArgs(params) });
            return result.rows[0];
        },
        async all(...params) {
            const result = await executor.execute({ sql, args: toArgs(params) });
            return result.rows;
        },
    };
}

class TursoDatabase {
    constructor() {
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
        } catch (err) {
            console.error('Database initialization note:', err.message);
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
            await transaction.rollback();
            throw error;
        }
    }
}

module.exports = new TursoDatabase();
const Database = require('better-sqlite3');

const db = new Database('data.db');

db.exec(`
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
        all_time_earnings REAL NOT NULL DEFAULT 0
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
`);

try { db.exec(`ALTER TABLE companies ADD COLUMN all_time_earnings REAL NOT NULL DEFAULT 0`); } catch (_) {}

module.exports = db;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const os = require('os');
const path = require('path');
const treasury = require('../src/treasury.js');
const { commands } = require('../src/deploy-commands.js');

let dbCounter = 0;
function createMockDb() {
    dbCounter++;
    const tmpFile = path.join(os.tmpdir(), `test_treasury_${Date.now()}_${dbCounter}.db`);
    const client = createClient({ url: `file:${tmpFile}` });

    function toArgs(params) {
        if (params.length === 0) return [];
        if (params.length === 1 && Array.isArray(params[0])) return params[0];
        return params;
    }

    function createStmt(executor, sql) {
        return {
            async run(...params) {
                const args = toArgs(params);
                const res = await executor.execute({ sql, args });
                return {
                    changes: Number(res.rowsAffected ?? 0),
                    lastInsertRowid: Number(res.lastInsertRowid ?? 0),
                };
            },
            async get(...params) {
                const args = toArgs(params);
                const res = await executor.execute({ sql, args });
                return res.rows?.[0];
            },
            async all(...params) {
                const args = toArgs(params);
                const res = await executor.execute({ sql, args });
                return res.rows ?? [];
            },
        };
    }

    const db = {
        async init() {
            await client.executeMultiple(`
                CREATE TABLE users (
                    discord_id TEXT PRIMARY KEY,
                    wallet_tokens REAL NOT NULL DEFAULT 0,
                    portfolio TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE companies (
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
                CREATE TABLE price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker TEXT NOT NULL,
                    price REAL NOT NULL,
                    timestamp INTEGER NOT NULL
                );
                CREATE TABLE sell_orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    seller_id TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    shares INTEGER NOT NULL,
                    list_price REAL NOT NULL,
                    timestamp INTEGER NOT NULL
                );
                CREATE TABLE trade_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker TEXT NOT NULL,
                    buyer_id TEXT NOT NULL,
                    seller_id TEXT NOT NULL,
                    shares INTEGER NOT NULL,
                    trade_value REAL NOT NULL,
                    fee_amount REAL NOT NULL,
                    timestamp INTEGER NOT NULL
                );
                CREATE TABLE cashout_requests (
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
                CREATE TABLE lax_account (
                    id INTEGER PRIMARY KEY,
                    balance REAL NOT NULL DEFAULT 0,
                    debt_floor REAL NOT NULL DEFAULT -10000,
                    kill_switch_enabled INTEGER NOT NULL DEFAULT 0,
                    realized_pnl REAL NOT NULL DEFAULT 0,
                    total_withdrawn REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE lax_treasury (
                    ticker TEXT PRIMARY KEY,
                    shares INTEGER NOT NULL DEFAULT 0,
                    total_acquisition_cost REAL NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE lax_treasury_lots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker TEXT NOT NULL,
                    shares INTEGER NOT NULL,
                    original_shares INTEGER NOT NULL,
                    unit_cost REAL NOT NULL,
                    total_cost REAL NOT NULL,
                    timestamp INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                );
                CREATE TABLE lax_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transaction_id TEXT NOT NULL UNIQUE,
                    transaction_type TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    ticker TEXT,
                    shares INTEGER NOT NULL DEFAULT 0,
                    price_per_share REAL NOT NULL DEFAULT 0,
                    total_value REAL NOT NULL DEFAULT 0,
                    acquisition_cost REAL DEFAULT 0,
                    realized_pnl REAL DEFAULT 0,
                    resulting_lax_balance REAL NOT NULL,
                    resulting_treasury_shares INTEGER NOT NULL DEFAULT 0,
                    timestamp INTEGER NOT NULL
                );
                CREATE TABLE user_cooldowns (
                    user_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    last_used_at INTEGER NOT NULL,
                    PRIMARY KEY (user_id, action)
                );
                INSERT INTO lax_account (id, balance, debt_floor, kill_switch_enabled, realized_pnl, total_withdrawn)
                VALUES (1, 0, -10000, 0, 0, 0);
            `);
        },
        prepare(sql) {
            return createStmt(client, sql);
        },
        async transaction(cb) {
            const tx = await client.transaction('write');
            const txDb = {
                prepare: sql => createStmt(tx, sql),
            };
            try {
                const res = await cb(txDb);
                await tx.commit();
                return res;
            } catch (err) {
                await tx.rollback();
                throw err;
            }
        },
    };

    return db;
}

test('Deploy Commands: /sell, /treasury, and /admin-instant-sell slash commands are defined', () => {
    const sellCmd = commands.find(c => c.name === 'sell');
    assert.ok(sellCmd, '/sell command must be defined');
    assert.strictEqual(sellCmd.options.length, 2);

    const treasuryCmd = commands.find(c => c.name === 'treasury');
    assert.ok(treasuryCmd, '/treasury command must be defined');

    const adminTreasuryCmd = commands.find(c => c.name === 'admin-instant-sell');
    assert.ok(adminTreasuryCmd, '/admin-instant-sell must be defined');
    assert.ok(adminTreasuryCmd.default_member_permissions !== undefined, 'Admin permission required');
});

test('Instant Sell: User can sell valid shares, receives correct amount, shares move to Treasury', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('TESLA', 'Tesla Inc', 'owner1', 100, 100, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user1', 500, JSON.stringify({ TESLA: 10 }));

    const res = await treasury.executeInstantSell(db, {
        userId: 'user1',
        ticker: 'TESLA',
        shares: 5,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sharesSold, 5);
    assert.strictEqual(res.buybackPrice, 100);
    assert.strictEqual(res.totalTokensReceived, 500); // 5 * 100 = 500 tokens (NO 1% fee on instant sell)
    assert.strictEqual(res.newUserBalance, 1000); // 500 + 500

    // User portfolio check
    const user = await db.prepare('SELECT * FROM users WHERE discord_id = ?').get('user1');
    const port = JSON.parse(user.portfolio);
    assert.strictEqual(port.TESLA, 5);
    assert.strictEqual(user.wallet_tokens, 1000);

    // Treasury inventory check
    const trItem = await db.prepare('SELECT * FROM lax_treasury WHERE ticker = ?').get('TESLA');
    assert.strictEqual(trItem.shares, 5);
    assert.strictEqual(trItem.total_acquisition_cost, 500);

    // LAX Account balance check
    const lax = await db.prepare('SELECT * FROM lax_account WHERE id = 1').get();
    assert.strictEqual(lax.balance, -500);

    // FIFO Lots check
    const lots = await db.prepare('SELECT * FROM lax_treasury_lots WHERE ticker = ?').all('TESLA');
    assert.strictEqual(lots.length, 1);
    assert.strictEqual(lots[0].shares, 5);
    assert.strictEqual(lots[0].unit_cost, 100);
    assert.strictEqual(lots[0].total_cost, 500);

    // Audit transaction check
    const txs = await db.prepare('SELECT * FROM lax_transactions WHERE transaction_type = ?').all('INSTANT_SELL');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].shares, 5);
    assert.strictEqual(txs[0].total_value, 500);
    assert.strictEqual(txs[0].acquisition_cost, 500);
    assert.strictEqual(txs[0].resulting_lax_balance, -500);
    assert.strictEqual(txs[0].resulting_treasury_shares, 5);
});

test('Instant Sell: 10,000-token maximum is enforced (exact 10k passes, 10,000.01 fails)', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('GOLD', 'Gold Corp', 'owner1', 100, 100, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_gold', 0, JSON.stringify({ GOLD: 200 }));

    // Exactly 10,000 tokens (100 shares @ 100 = 10,000)
    const exactRes = await treasury.executeInstantSell(db, {
        userId: 'user_gold',
        ticker: 'GOLD',
        shares: 100,
    });
    assert.strictEqual(exactRes.success, true);
    assert.strictEqual(exactRes.totalTokensReceived, 10000);

    // Reset cooldown to test over-limit
    await db.prepare('DELETE FROM user_cooldowns').run();

    // Set price to 100.01 tokens
    await db.prepare('UPDATE companies SET current_price = 100.01 WHERE ticker = ?').run('GOLD');

    // 100 shares @ 100.01 = 10,001.00 tokens -> Must fail
    const overRes = await treasury.executeInstantSell(db, {
        userId: 'user_gold',
        ticker: 'GOLD',
        shares: 100,
    });
    assert.strictEqual(overRes.success, false);
    assert.ok(overRes.error.includes('Maximum instant-sell value'));
});

test('Instant Sell: 1-hour cooldown is enforced and failed sales do NOT consume cooldown', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('AAPL', 'Apple Inc', 'owner1', 50, 50, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_cd', 0, JSON.stringify({ AAPL: 50 }));

    // 1. First successful sale
    const firstSale = await treasury.executeInstantSell(db, {
        userId: 'user_cd',
        ticker: 'AAPL',
        shares: 10,
    });
    assert.strictEqual(firstSale.success, true);

    // 2. Immediate second sale should be rejected by cooldown
    const secondSale = await treasury.executeInstantSell(db, {
        userId: 'user_cd',
        ticker: 'AAPL',
        shares: 10,
    });
    assert.strictEqual(secondSale.success, false);
    assert.ok(secondSale.error.includes('cooldown'));

    // 3. Failed sale for a different user (e.g. not owning shares) must NOT consume cooldown
    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_fail', 0, '{}');

    const failedAttempt = await treasury.executeInstantSell(db, {
        userId: 'user_fail',
        ticker: 'AAPL',
        shares: 5,
    });
    assert.strictEqual(failedAttempt.success, false);

    // Verify user_fail has no cooldown record
    const cdRecord = await db.prepare('SELECT * FROM user_cooldowns WHERE user_id = ?').get('user_fail');
    assert.strictEqual(cdRecord, undefined);
});

test('Instant Sell: User cannot sell shares they do not own', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('MSFT', 'Microsoft', 'owner1', 200, 200, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_msft', 0, JSON.stringify({ MSFT: 3 }));

    const res = await treasury.executeInstantSell(db, {
        userId: 'user_msft',
        ticker: 'MSFT',
        shares: 4, // Owns 3, tries to sell 4
    });

    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Insufficient shares'));
});

test('Instant Sell: LAX debt floor is enforced and configurable', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('NVDA', 'Nvidia', 'owner1', 1000, 1000, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_nvda', 0, JSON.stringify({ NVDA: 20 }));

    // Set LAX balance to -8,000 (debt floor is -10,000)
    await db.prepare('UPDATE lax_account SET balance = -8000 WHERE id = 1').run();

    // Selling 3 shares @ 1000 = 3,000 tokens -> would result in balance -11,000 < -10,000 -> REJECT
    const res = await treasury.executeInstantSell(db, {
        userId: 'user_nvda',
        ticker: 'NVDA',
        shares: 3,
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('debt floor'));

    // Reconfigure debt floor to -15,000 tokens
    const updateFloor = await treasury.setDebtFloor(db, -15000);
    assert.strictEqual(updateFloor.success, true);
    assert.strictEqual(updateFloor.debtFloor, -15000);

    // Now selling 3 shares results in -11,000 >= -15,000 -> SUCCEEDS
    const res2 = await treasury.executeInstantSell(db, {
        userId: 'user_nvda',
        ticker: 'NVDA',
        shares: 3,
    });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.resultingLaxBalance, -11000);
});

test('Treasury Sales: Fulfilling from Treasury calculates realized profit and loss correctly', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('META', 'Meta Platforms', 'owner1', 630, 630, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('seller_meta', 0, JSON.stringify({ META: 2 }));

    // User instant sells 1 share for 630 tokens
    const sellRes = await treasury.executeInstantSell(db, {
        userId: 'seller_meta',
        ticker: 'META',
        shares: 1,
    });
    assert.strictEqual(sellRes.success, true);

    // Verify Treasury holds 1 share @ 630 cost
    const tr = await treasury.getTreasuryInventory(db, 'META');
    assert.strictEqual(tr.shares, 1);
    assert.strictEqual(tr.total_acquisition_cost, 630);

    // Later: Another player buys that share when market price is 700 tokens
    const tradeTime = Date.now();
    const fulfillRes = await db.transaction(async tx => {
        return await treasury.fulfillFromTreasury(tx, {
            ticker: 'META',
            requestedShares: 1,
            currentPrice: 700,
            tradeTimestamp: tradeTime,
            buyerId: 'buyer_meta',
        });
    });

    assert.strictEqual(fulfillRes.sharesFilled, 1);
    assert.strictEqual(fulfillRes.grossValue, 700);
    assert.strictEqual(fulfillRes.feeAmount, 7); // 1% of 700
    assert.strictEqual(fulfillRes.netProceeds, 693); // 700 - 7
    assert.strictEqual(fulfillRes.acquisitionCost, 630);
    assert.strictEqual(fulfillRes.realizedPnL, 63); // 693 - 630 = +63 realized profit

    // Treasury shares should now be 0
    const trAfter = await treasury.getTreasuryInventory(db, 'META');
    assert.strictEqual(trAfter.shares, 0);
    assert.strictEqual(trAfter.total_acquisition_cost, 0);

    // Verify Realized PnL is tracked in LAX account
    const lax = await treasury.getLaxAccount(db);
    assert.strictEqual(lax.realized_pnl, 63);
    assert.strictEqual(lax.withdrawable_profit, 63);

    // Now test a LOSS scenario:
    // User instant sells 1 share for 600 tokens
    await db.prepare('DELETE FROM user_cooldowns').run();
    await db.prepare('UPDATE companies SET current_price = 600 WHERE ticker = ?').run('META');
    await treasury.executeInstantSell(db, {
        userId: 'seller_meta',
        ticker: 'META',
        shares: 1,
    });

    // Share is later sold at market price of 500 tokens (loss)
    const lossFulfill = await db.transaction(async tx => {
        return await treasury.fulfillFromTreasury(tx, {
            ticker: 'META',
            requestedShares: 1,
            currentPrice: 500,
            tradeTimestamp: Date.now(),
            buyerId: 'buyer_loss',
        });
    });

    assert.strictEqual(lossFulfill.sharesFilled, 1);
    assert.strictEqual(lossFulfill.grossValue, 500);
    assert.strictEqual(lossFulfill.feeAmount, 5);
    assert.strictEqual(lossFulfill.netProceeds, 495);
    assert.strictEqual(lossFulfill.acquisitionCost, 600);
    assert.strictEqual(lossFulfill.realizedPnL, -105); // 495 - 600 = -105 (Loss)

    const laxFinal = await treasury.getLaxAccount(db);
    assert.strictEqual(laxFinal.realized_pnl, 63 - 105); // -42
    assert.strictEqual(laxFinal.withdrawable_profit, 0); // No withdrawable profit when cumulative pnl <= 0
});

test('Treasury: Cannot sell more inventory than Treasury owns', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('AMZN', 'Amazon', 'owner1', 100, 100, 1000, 500, 500);

    // Treasury has 2 shares
    await db.prepare('INSERT INTO lax_treasury (ticker, shares, total_acquisition_cost, updated_at) VALUES (?, ?, ?, ?)')
        .run('AMZN', 2, 200, Date.now());
    await db.prepare('INSERT INTO lax_treasury_lots (ticker, shares, original_shares, unit_cost, total_cost, timestamp, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('AMZN', 2, 2, 100, 200, Date.now(), 'active');

    // Fulfill request for 5 shares
    const res = await db.transaction(async tx => {
        return await treasury.fulfillFromTreasury(tx, {
            ticker: 'AMZN',
            requestedShares: 5,
            currentPrice: 100,
            tradeTimestamp: Date.now(),
            buyerId: 'buyer_amzn',
        });
    });

    // Treasury fills ONLY its available 2 shares
    assert.strictEqual(res.sharesFilled, 2);

    const trAfter = await treasury.getTreasuryInventory(db, 'AMZN');
    assert.strictEqual(trAfter.shares, 0);
});

test('Kill switch: Admin can disable Instant Sell and block transactions', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('GOOG', 'Google', 'owner1', 150, 150, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_goog', 0, JSON.stringify({ GOOG: 5 }));

    // Enable killswitch
    await treasury.setKillSwitch(db, true);

    const res = await treasury.executeInstantSell(db, {
        userId: 'user_goog',
        ticker: 'GOOG',
        shares: 1,
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('disabled by administration'));

    // Disable killswitch
    await treasury.setKillSwitch(db, false);

    const res2 = await treasury.executeInstantSell(db, {
        userId: 'user_goog',
        ticker: 'GOOG',
        shares: 1,
    });
    assert.strictEqual(res2.success, true);
});

test('Accounting & Security: Owner can only withdraw realized profit, not unrealized Treasury inventory', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('NFLX', 'Netflix', 'owner1', 500, 500, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_nflx', 0, JSON.stringify({ NFLX: 2 }));

    // Instant sell 2 shares @ 500 = 1000 tokens
    await treasury.executeInstantSell(db, {
        userId: 'user_nflx',
        ticker: 'NFLX',
        shares: 2,
    });

    // Unrealized inventory exists (2 shares worth 1000 tokens), but realized profit is 0
    const account = await treasury.getLaxAccount(db);
    assert.strictEqual(account.realized_pnl, 0);
    assert.strictEqual(account.withdrawable_profit, 0);

    // Attempt to withdraw profit before realization -> Must fail
    const withdrawAttempt1 = await treasury.withdrawRealizedProfit(db, {
        ownerId: 'owner1',
        amount: 100,
    });
    assert.strictEqual(withdrawAttempt1.success, false);
    assert.ok(withdrawAttempt1.error.includes('Maximum withdrawable'));

    // Sell 1 share from Treasury at 600 tokens -> Gross: 600, Fee: 6, Net: 594, AcqCost: 500 -> Realized PnL = +94
    await db.transaction(async tx => {
        await treasury.fulfillFromTreasury(tx, {
            ticker: 'NFLX',
            requestedShares: 1,
            currentPrice: 600,
            tradeTimestamp: Date.now(),
            buyerId: 'buyer_nflx',
        });
    });

    const accountAfterSale = await treasury.getLaxAccount(db);
    assert.strictEqual(accountAfterSale.realized_pnl, 94);
    assert.strictEqual(accountAfterSale.withdrawable_profit, 94);

    // Withdraw 50 tokens of realized profit
    const withdrawSuccess = await treasury.withdrawRealizedProfit(db, {
        ownerId: 'owner1',
        amount: 50,
    });
    assert.strictEqual(withdrawSuccess.success, true);
    assert.strictEqual(withdrawSuccess.withdrawnAmount, 50);
    assert.strictEqual(withdrawSuccess.remainingWithdrawable, 44);

    // Owner wallet has received 50 tokens
    const ownerUser = await db.prepare('SELECT * FROM users WHERE discord_id = ?').get('owner1');
    assert.strictEqual(ownerUser.wallet_tokens, 50);
});

test('Concurrent Execution: User cannot bypass limits or duplicate sales via simultaneous requests', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO companies (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('COIN', 'Coinbase', 'owner1', 100, 100, 1000, 500, 500);

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)')
        .run('user_concurrent', 0, JSON.stringify({ COIN: 5 }));

    // Run two simultaneous instant sell requests for the same user
    const [req1, req2] = await Promise.all([
        treasury.executeInstantSell(db, { userId: 'user_concurrent', ticker: 'COIN', shares: 5 }),
        treasury.executeInstantSell(db, { userId: 'user_concurrent', ticker: 'COIN', shares: 5 }),
    ]);

    // Exactly one must succeed and one must fail (either in-flight lock or cooldown or insufficient shares)
    const successes = [req1, req2].filter(r => r.success);
    const failures = [req1, req2].filter(r => !r.success);

    assert.strictEqual(successes.length, 1, 'Only one concurrent instant sell can succeed');
    assert.strictEqual(failures.length, 1, 'The duplicate concurrent sell must be rejected');

    // Verify user balance is exactly 500 tokens (not 1,000)
    const user = await db.prepare('SELECT * FROM users WHERE discord_id = ?').get('user_concurrent');
    assert.strictEqual(user.wallet_tokens, 500);
});

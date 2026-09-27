const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const {
    MAX_CASHOUT_AMOUNT,
    validateCashoutAmount,
    createCashoutRequest,
    approveCashoutRequest,
    rejectCashoutRequest,
} = require('../src/cashout.js');
const { commands } = require('../src/deploy-commands.js');

const os = require('os');
const path = require('path');
const fs = require('fs');

let dbCounter = 0;
function createMockDb() {
    dbCounter++;
    const tmpFile = path.join(os.tmpdir(), `test_cashout_${Date.now()}_${dbCounter}.db`);
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

test('Cashout slash command is registered in deploy-commands', () => {
    const cashoutCmd = commands.find(c => c.name === 'cashout');
    assert.ok(cashoutCmd, '/cashout command must be defined');
    assert.strictEqual(cashoutCmd.description.includes('8,000'), true);
});

test('Validation: insufficient balance is rejected', () => {
    const result = validateCashoutAmount(1000, 500);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('Insufficient balance'));
});

test('Validation: exactly 8,000 tokens is accepted', () => {
    const result = validateCashoutAmount(8000, 10000);
    assert.strictEqual(result.valid, true);
});

test('Validation: over 8,000 tokens is rejected', () => {
    const result = validateCashoutAmount(8001, 10000);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('Maximum cashout limit'));
});

test('Database Flow: pending request does NOT deduct user balance', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens) VALUES (?, ?)').run('user123', 5000);

    const created = await createCashoutRequest(db, {
        userId: 'user123',
        amount: 2000,
        channelId: 'chan-1',
    });

    assert.strictEqual(created.success, true);
    assert.strictEqual(created.status, 'pending');

    // Verify user balance is STILL 5,000 tokens (untouched)
    const userAfter = await db.prepare('SELECT wallet_tokens FROM users WHERE discord_id = ?').get('user123');
    assert.strictEqual(userAfter.wallet_tokens, 5000);
});

test('Database Flow: approval deducts balance exactly once and records audit data', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens) VALUES (?, ?)').run('user_abc', 5000);

    const created = await createCashoutRequest(db, {
        userId: 'user_abc',
        amount: 2000,
        channelId: 'chan-abc',
    });

    const approval = await approveCashoutRequest(db, {
        requestId: created.requestId,
        adminId: 'admin_xyz',
    });

    assert.strictEqual(approval.success, true);
    assert.strictEqual(approval.remainingBalance, 3000);

    // Verify balance is deducted
    const user = await db.prepare('SELECT wallet_tokens FROM users WHERE discord_id = ?').get('user_abc');
    assert.strictEqual(user.wallet_tokens, 3000);

    // Verify audit record in cashout_requests
    const req = await db.prepare('SELECT * FROM cashout_requests WHERE id = ?').get(created.requestId);
    assert.strictEqual(req.status, 'completed');
    assert.strictEqual(req.admin_id, 'admin_xyz');
});

test('Database Flow: rejection leaves user balance completely unchanged', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens) VALUES (?, ?)').run('user_rej', 4000);

    const created = await createCashoutRequest(db, {
        userId: 'user_rej',
        amount: 1500,
        channelId: 'chan-rej',
    });

    const rejection = await rejectCashoutRequest(db, {
        requestId: created.requestId,
        adminId: 'admin_rej',
        reason: 'Payment method invalid',
    });

    assert.strictEqual(rejection.success, true);

    // Verify balance was NEVER deducted
    const user = await db.prepare('SELECT wallet_tokens FROM users WHERE discord_id = ?').get('user_rej');
    assert.strictEqual(user.wallet_tokens, 4000);

    // Verify audit record status
    const req = await db.prepare('SELECT * FROM cashout_requests WHERE id = ?').get(created.requestId);
    assert.strictEqual(req.status, 'rejected');
    assert.strictEqual(req.admin_id, 'admin_rej');
});

test('Database Flow: balance changing while request is pending prevents overdraft', async () => {
    const db = createMockDb();
    await db.init();

    // User starts with 3,000 tokens
    await db.prepare('INSERT INTO users (discord_id, wallet_tokens) VALUES (?, ?)').run('user_spender', 3000);

    // Creates request for 2,500 tokens
    const created = await createCashoutRequest(db, {
        userId: 'user_spender',
        amount: 2500,
        channelId: 'chan-spend',
    });
    assert.strictEqual(created.success, true);

    // User spends 2,000 tokens elsewhere (buying stocks, transferring, etc.), leaving 1,000 tokens
    await db.prepare('UPDATE users SET wallet_tokens = 1000 WHERE discord_id = ?').run('user_spender');

    // Admin tries to approve the 2,500 token request
    const approval = await approveCashoutRequest(db, {
        requestId: created.requestId,
        adminId: 'admin_boss',
    });

    assert.strictEqual(approval.success, false);
    assert.ok(approval.error.includes('Insufficient balance'));

    // Verify user balance was NOT driven negative
    const user = await db.prepare('SELECT wallet_tokens FROM users WHERE discord_id = ?').get('user_spender');
    assert.strictEqual(user.wallet_tokens, 1000);
});

test('Database Flow: duplicate approval is safely rejected', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens) VALUES (?, ?)').run('user_dup', 6000);

    const created = await createCashoutRequest(db, {
        userId: 'user_dup',
        amount: 2000,
        channelId: 'chan-dup',
    });

    // First approval
    const firstApproval = await approveCashoutRequest(db, {
        requestId: created.requestId,
        adminId: 'admin_1',
    });
    assert.strictEqual(firstApproval.success, true);

    // Second duplicate approval attempt (e.g. double click)
    const secondApproval = await approveCashoutRequest(db, {
        requestId: created.requestId,
        adminId: 'admin_2',
    });
    assert.strictEqual(secondApproval.success, false);
    assert.ok(secondApproval.error.includes('already'));

    // Verify balance was only deducted ONCE (6000 - 2000 = 4000)
    const user = await db.prepare('SELECT wallet_tokens FROM users WHERE discord_id = ?').get('user_dup');
    assert.strictEqual(user.wallet_tokens, 4000);
});

test('Security: user cannot approve their own cashout request', async () => {
    const db = createMockDb();
    await db.init();

    await db.prepare('INSERT INTO users (discord_id, wallet_tokens) VALUES (?, ?)').run('same_user', 5000);

    const created = await createCashoutRequest(db, {
        userId: 'same_user',
        amount: 1000,
        channelId: 'chan-self',
    });

    const approval = await approveCashoutRequest(db, {
        requestId: created.requestId,
        adminId: 'same_user', // Self-approval attempt
    });

    assert.strictEqual(approval.success, false);
    assert.ok(approval.error.includes('cannot approve your own cashout'));

    // Verify balance untouched
    const user = await db.prepare('SELECT wallet_tokens FROM users WHERE discord_id = ?').get('same_user');
    assert.strictEqual(user.wallet_tokens, 5000);
});

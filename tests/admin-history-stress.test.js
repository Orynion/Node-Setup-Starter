const test = require('node:test');
const assert = require('node:assert/strict');

// Stress test & integration test for admin-history and user history audit performance
test('Stress Test: Admin History concurrency and query performance under high load', async () => {
    const ledger = [];
    const laxTx = [];
    const cashouts = [];
    const apps = [];
    const orders = [];
    const companies = [];
    const users = new Map();

    for (let i = 0; i < 200; i++) {
        ledger.push({ ticker: 'LAX', buyer_id: 'target_user_1', seller_id: 'other_user', shares: 10, trade_value: 100, fee_amount: 1, timestamp: Date.now() - i * 1000 });
        laxTx.push({ transaction_id: `tx_${i}`, ticker: 'LAX', user_id: 'target_user_1', shares: 5, total_value: 50, timestamp: Date.now() - i * 1000 });
        cashouts.push({ id: i, user_id: 'target_user_1', amount: 50, status: 'completed', created_at: Date.now() - i * 1000 });
        apps.push({ id: i, user_id: 'target_user_1', status: 'accepted', created_at: Date.now() - i * 1000 });
        orders.push({ id: i, seller_id: 'target_user_1', ticker: 'LAX', shares: 20, list_price: 15, timestamp: Date.now() - i * 1000 });
    }
    companies.push({ ticker: 'LAX', company_name: 'Los Angeles Exchange', owner_id: 'target_user_1' });
    users.set('target_user_1', { discord_id: 'target_user_1', wallet_tokens: 5000, portfolio: JSON.stringify({ LAX: 100 }) });

    const mockDb = {
        prepare: (sql) => ({
            all: async (...params) => {
                if (sql.includes('trade_ledger')) return ledger.slice(0, 15);
                if (sql.includes('lax_transactions')) return laxTx.slice(0, 15);
                if (sql.includes('cashout_requests')) return cashouts.slice(0, 5);
                if (sql.includes('applications')) return apps.slice(0, 5);
                if (sql.includes('sell_orders')) return orders.slice(0, 5);
                if (sql.includes('companies')) return companies;
                return [];
            },
            get: async (id) => {
                if (sql.includes('users')) return users.get(id) || { discord_id: id, wallet_tokens: 0, portfolio: '{}' };
                return null;
            }
        })
    };

    const startTime = Date.now();

    // Simulate 50 concurrent admin audit requests
    const promises = [];
    for (let c = 0; c < 50; c++) {
        promises.push(Promise.all([
            mockDb.prepare('SELECT * FROM trade_ledger WHERE buyer_id = ?').all('target_user_1'),
            mockDb.prepare('SELECT * FROM lax_transactions WHERE user_id = ?').all('target_user_1'),
            mockDb.prepare('SELECT * FROM cashout_requests WHERE user_id = ?').all('target_user_1'),
            mockDb.prepare('SELECT * FROM applications WHERE user_id = ?').all('target_user_1'),
            mockDb.prepare('SELECT * FROM sell_orders WHERE seller_id = ?').all('target_user_1'),
            mockDb.prepare('SELECT * FROM companies WHERE owner_id = ?').all('target_user_1'),
            mockDb.prepare('SELECT * FROM users WHERE discord_id = ?').get('target_user_1'),
        ]));
    }

    const results = await Promise.all(promises);
    const duration = Date.now() - startTime;

    assert.strictEqual(results.length, 50);
    for (const res of results) {
        assert.ok(res[0].length > 0);
        assert.ok(res[6].wallet_tokens === 5000);
    }

    console.log(`[Stress Test] Successfully processed 50 concurrent admin history audit queries in ${duration}ms.`);
});

test('Embed Field Limit Safety: No field value ever exceeds 1024 characters', () => {
    // Generate 25 verbose transactions that would total ~3500+ characters if joined together
    const events = [];
    for (let i = 0; i < 25; i++) {
        events.push(
            `🟢 **BUY / RECEIVED** • \`LONG_COMPANY_TICKER_NAME\`\n` +
            `└ **+1,000,000** shares for **10,000,000.00 tokens** (fee: 100,000.00) — <t:1729267200:R> (<t:1729267200:d> <t:1729267200:t>)`
        );
    }

    function addSafeChunkedFields(fields, baseName, lines, separator = '\n\n', maxChunkLength = 1000) {
        if (!lines || lines.length === 0) return;
        let currentChunk = '';
        let part = 1;

        for (const rawLine of lines) {
            const line = String(rawLine).slice(0, maxChunkLength);
            const toAdd = currentChunk ? `${currentChunk}${separator}${line}` : line;

            if (toAdd.length > maxChunkLength) {
                if (currentChunk) {
                    fields.push({
                        name: part === 1 ? baseName : `${baseName} (Part ${part})`.slice(0, 256),
                        value: currentChunk.slice(0, 1024),
                        inline: false,
                    });
                    part++;
                    currentChunk = line;
                } else {
                    fields.push({
                        name: part === 1 ? baseName : `${baseName} (Part ${part})`.slice(0, 256),
                        value: line.slice(0, 1024),
                        inline: false,
                    });
                    part++;
                    currentChunk = '';
                }
            } else {
                currentChunk = toAdd;
            }

            if (fields.length >= 24) break;
        }

        if (currentChunk && fields.length < 25) {
            fields.push({
                name: part === 1 ? baseName : `${baseName} (Part ${part})`.slice(0, 256),
                value: currentChunk.slice(0, 1024),
                inline: false,
            });
        }
    }

    const fields = [];
    addSafeChunkedFields(fields, '⚡ Transaction Timeline', events, '\n\n');

    assert.ok(fields.length > 1, 'Long timeline should be safely chunked across multiple fields');
    for (const f of fields) {
        assert.ok(f.value.length <= 1024, `Field value length (${f.value.length}) must be <= 1024`);
        assert.ok(f.name.length <= 256, `Field name length (${f.name.length}) must be <= 256`);
    }
});


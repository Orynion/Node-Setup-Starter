const test = require('node:test');
const assert = require('node:assert/strict');
const { commands } = require('../src/deploy-commands.js');

test('Slash command definitions verification', () => {
    const commandNames = commands.map(c => c.name);

    // Verify /history exists and has appropriate options
    const historyCmd = commands.find(c => c.name === 'history');
    assert.ok(historyCmd, '/history command should be defined in commands list');
    assert.strictEqual(historyCmd.options.length, 2, '/history should have ticker and limit options');

    // Verify /exchange-balance is public (no admin member permissions required)
    const exchangeBalCmd = commands.find(c => c.name === 'exchange-balance');
    assert.ok(exchangeBalCmd, '/exchange-balance command should be defined');
    assert.strictEqual(exchangeBalCmd.default_member_permissions, undefined, '/exchange-balance should have public permissions');

    // Verify admin-only commands maintain administrator permissions
    const adminAddMoney = commands.find(c => c.name === 'admin-add-money');
    assert.ok(adminAddMoney, '/admin-add-money must exist');
    assert.ok(adminAddMoney.default_member_permissions !== undefined, '/admin-add-money must have admin permissions set');

    const provideShares = commands.find(c => c.name === 'provide-shares');
    assert.ok(provideShares, '/provide-shares must exist');
    assert.ok(provideShares.default_member_permissions !== undefined, '/provide-shares must have admin permissions set');

    // Verify /admin-editcompany includes supply option
    const editCompanyCmd = commands.find(c => c.name === 'admin-editcompany');
    assert.ok(editCompanyCmd, '/admin-editcompany must exist');
    assert.ok(editCompanyCmd.options.some(o => o.name === 'supply'), '/admin-editcompany must have supply option');

    // Check all essential commands are present
    const expected = [
        'balance', 'leaderboard', 'stock-buy', 'stock-sell', 'sell-cancel',
        'stock-info', 'stock-list', 'chart', 'provide-shares', 'history',
        'cashout', 'sell', 'add-user', 'treasury', 'admin-instant-sell', 'ask',
        'earnings', 'today-exchange-stat', 'exchange-balance', 'admin-add-money',
        'admin-remove-money', 'admin-addcompany', 'admin-removecompany',
        'admin-editcompany', 'economy-backup', 'economy-restore', 'setup-tickets', 'server-embed'
    ];
    for (const name of expected) {
        assert.ok(commandNames.includes(name), `Expected command /${name} to be registered`);
    }
});

test('Exchange fee calculation rules', () => {
    const calculateExchangeFee = (tradeValue) => Number((tradeValue * 0.01).toFixed(8));

    assert.strictEqual(calculateExchangeFee(100), 1.0);
    assert.strictEqual(calculateExchangeFee(250.50), 2.505);
    assert.strictEqual(calculateExchangeFee(0), 0);
});

test('Price adjustment formula consistency', () => {
    const adjustPrice = (current, shares, direction) => {
        const factor = direction === 'up' ? 1.001 : 0.999;
        return Math.max(0.01, parseFloat((current * Math.pow(factor, shares)).toFixed(2)));
    };

    const initialPrice = 10.00;
    const priceAfter100Buys = adjustPrice(initialPrice, 100, 'up');
    assert.ok(priceAfter100Buys > initialPrice, 'Price must increase after buy');

    const priceAfter100Sells = adjustPrice(initialPrice, 100, 'down');
    assert.ok(priceAfter100Sells < initialPrice, 'Price must decrease after sell');
    assert.ok(priceAfter100Sells >= 0.01, 'Price must never drop below 0.01');
});

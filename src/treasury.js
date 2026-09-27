const crypto = require('crypto');

const MAX_INSTANT_SELL_VALUE = 10000;
const INSTANT_SELL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour in ms
const DEFAULT_DEBT_FLOOR = -10000;
const EXCHANGE_FEE_RATE = 0.01;

function fmt(n) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function generateTxId(prefix = 'tx') {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function adjustPrice(current, shares, direction) {
    const factor = direction === 'up' ? 1.001 : 0.999;
    return Math.max(0.01, parseFloat((current * Math.pow(factor, shares)).toFixed(2)));
}

function calculateExchangeFee(tradeValue) {
    return Number((tradeValue * EXCHANGE_FEE_RATE).toFixed(8));
}

function getPortfolio(user) {
    try {
        return typeof user.portfolio === 'string' ? JSON.parse(user.portfolio) : (user.portfolio || {});
    } catch {
        return {};
    }
}

/**
 * Retrieves the global LAX accounting record.
 */
async function getLaxAccount(db) {
    let account = await db.prepare('SELECT * FROM lax_account WHERE id = 1').get();
    if (!account) {
        await db.prepare(`
            INSERT OR IGNORE INTO lax_account (id, balance, debt_floor, kill_switch_enabled, realized_pnl, total_withdrawn)
            VALUES (1, 0, ?, 0, 0, 0)
        `).run(DEFAULT_DEBT_FLOOR);
        account = await db.prepare('SELECT * FROM lax_account WHERE id = 1').get();
    }
    const withdrawableProfit = Math.max(0, (account?.realized_pnl || 0) - (account?.total_withdrawn || 0));
    return {
        ...account,
        withdrawable_profit: withdrawableProfit,
    };
}

/**
 * Retrieves treasury inventory for all companies or a specific ticker.
 */
async function getTreasuryInventory(db, ticker = null) {
    if (ticker) {
        const item = await db.prepare('SELECT * FROM lax_treasury WHERE ticker = ?').get(ticker.toUpperCase());
        return item || { ticker: ticker.toUpperCase(), shares: 0, total_acquisition_cost: 0, updated_at: 0 };
    }
    return await db.prepare('SELECT * FROM lax_treasury WHERE shares > 0 ORDER BY shares DESC').all();
}

/**
 * Checks cooldown status for a user.
 */
async function getCooldown(db, userId) {
    const record = await db.prepare('SELECT * FROM user_cooldowns WHERE user_id = ? AND action = ?')
        .get(userId, 'instant_sell');
    const now = Date.now();
    if (!record) {
        return { onCooldown: false, remainingMs: 0, nextAvailableAt: now };
    }
    const elapsed = now - record.last_used_at;
    if (elapsed < INSTANT_SELL_COOLDOWN_MS) {
        const remainingMs = INSTANT_SELL_COOLDOWN_MS - elapsed;
        return {
            onCooldown: true,
            remainingMs,
            nextAvailableAt: record.last_used_at + INSTANT_SELL_COOLDOWN_MS,
            lastUsedAt: record.last_used_at,
        };
    }
    return { onCooldown: false, remainingMs: 0, nextAvailableAt: now, lastUsedAt: record.last_used_at };
}

/**
 * Pure validation logic for instant sell request.
 */
function validateInstantSell({ user, company, shares, laxAccount, cooldown, now = Date.now() }) {
    if (!company) {
        return { valid: false, reason: 'Company not found.' };
    }

    if (laxAccount?.kill_switch_enabled) {
        return { valid: false, reason: '⛔ Instant Sell is currently disabled by administration.' };
    }

    if (!Number.isInteger(shares) || shares <= 0) {
        return { valid: false, reason: 'Please enter a valid positive integer number of shares to sell.' };
    }

    if (cooldown?.onCooldown) {
        const remainingMin = Math.ceil(cooldown.remainingMs / 60000);
        return {
            valid: false,
            reason: `⏳ You are on cooldown. You can use Instant Sell again in **${remainingMin} minute${remainingMin === 1 ? '' : 's'}** (<t:${Math.floor(cooldown.nextAvailableAt / 1000)}:R>).`,
        };
    }

    const portfolio = getPortfolio(user || {});
    const ownedShares = portfolio[company.ticker] || 0;
    if (ownedShares < shares) {
        return {
            valid: false,
            reason: `Insufficient shares. You only own **${ownedShares}** share${ownedShares === 1 ? '' : 's'} of **${company.ticker}**, but requested to sell **${shares}**.`,
        };
    }

    const buybackPrice = company.current_price;
    const totalValue = Number((shares * buybackPrice).toFixed(8));

    if (totalValue > MAX_INSTANT_SELL_VALUE) {
        return {
            valid: false,
            reason: `❌ Maximum instant-sell value is **${MAX_INSTANT_SELL_VALUE.toLocaleString()} tokens** per transaction. (Requested: **${fmt(totalValue)} tokens** for ${shares} shares).`,
        };
    }

    const resultingLaxBalance = Number(((laxAccount?.balance ?? 0) - totalValue).toFixed(8));
    const debtFloor = laxAccount?.debt_floor ?? DEFAULT_DEBT_FLOOR;

    if (resultingLaxBalance < debtFloor) {
        return {
            valid: false,
            reason: `❌ Instant sell rejected: LAX liquidity limit reached. Executing this sale would push LAX balance (${fmt(resultingLaxBalance)}) below the debt floor (${fmt(debtFloor)} tokens).`,
        };
    }

    return {
        valid: true,
        buybackPrice,
        totalValue,
        resultingLaxBalance,
        ownedShares,
    };
}

// In-memory mutex to prevent simultaneous double execution per user
const inFlightUsers = new Set();

/**
 * Executes an instant sell atomically.
 */
async function executeInstantSell(db, { userId, ticker, shares }) {
    ticker = ticker.toUpperCase();
    if (inFlightUsers.has(userId)) {
        return { success: false, error: 'A transaction is already in progress for your account. Please wait.' };
    }

    inFlightUsers.add(userId);
    try {
        return await db.transaction(async (tx) => {
            const now = Date.now();
            const [userRecord, company, laxAccount, cooldown] = await Promise.all([
                tx.prepare('SELECT * FROM users WHERE discord_id = ?').get(userId),
                tx.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker),
                getLaxAccount(tx),
                getCooldown(tx, userId),
            ]);

            if (!userRecord) {
                return { success: false, error: 'User record not found.' };
            }

            const validation = validateInstantSell({
                user: userRecord,
                company,
                shares,
                laxAccount,
                cooldown,
                now,
            });

            if (!validation.valid) {
                return { success: false, error: validation.reason };
            }

            const { buybackPrice, totalValue, resultingLaxBalance } = validation;
            const portfolio = getPortfolio(userRecord);

            // 1. Deduct shares from user portfolio
            portfolio[ticker] = portfolio[ticker] - shares;
            if (portfolio[ticker] <= 0) {
                delete portfolio[ticker];
            }

            // 2. Credit tokens to user wallet
            await tx.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ?, portfolio = ? WHERE discord_id = ?')
                .run(totalValue, JSON.stringify(portfolio), userId);

            // 3. Update LAX Account Balance
            await tx.prepare('UPDATE lax_account SET balance = balance - ? WHERE id = 1')
                .run(totalValue);

            // 4. Update LAX Treasury Inventory
            const existingTreasury = await tx.prepare('SELECT * FROM lax_treasury WHERE ticker = ?').get(ticker);
            const currentTreasuryShares = existingTreasury ? existingTreasury.shares : 0;
            const currentAcquisitionCost = existingTreasury ? existingTreasury.total_acquisition_cost : 0;

            const newTreasuryShares = currentTreasuryShares + shares;
            const newAcquisitionCost = Number((currentAcquisitionCost + totalValue).toFixed(8));

            if (existingTreasury) {
                await tx.prepare('UPDATE lax_treasury SET shares = ?, total_acquisition_cost = ?, updated_at = ? WHERE ticker = ?')
                    .run(newTreasuryShares, newAcquisitionCost, now, ticker);
            } else {
                await tx.prepare('INSERT INTO lax_treasury (ticker, shares, total_acquisition_cost, updated_at) VALUES (?, ?, ?, ?)')
                    .run(ticker, newTreasuryShares, newAcquisitionCost, now);
            }

            // 5. Add FIFO Lot for Treasury Inventory tracking
            await tx.prepare(`
                INSERT INTO lax_treasury_lots (ticker, shares, original_shares, unit_cost, total_cost, timestamp, status)
                VALUES (?, ?, ?, ?, ?, ?, 'active')
            `).run(ticker, shares, shares, buybackPrice, totalValue, now);

            // 6. Adjust company market price down
            const newPrice = adjustPrice(company.current_price, shares, 'down');
            await tx.prepare('UPDATE companies SET current_price = ? WHERE ticker = ?').run(newPrice, ticker);
            await tx.prepare('INSERT INTO price_history (ticker, price, timestamp) VALUES (?, ?, ?)').run(ticker, newPrice, now);

            // 7. Update User Cooldown
            await tx.prepare(`
                INSERT INTO user_cooldowns (user_id, action, last_used_at)
                VALUES (?, 'instant_sell', ?)
                ON CONFLICT(user_id, action) DO UPDATE SET last_used_at = excluded.last_used_at
            `).run(userId, now);

            // 8. Record in trade_ledger (fee = 0 for instant sell)
            await tx.prepare(`
                INSERT INTO trade_ledger (ticker, buyer_id, seller_id, shares, trade_value, fee_amount, timestamp)
                VALUES (?, 'LAX_TREASURY', ?, ?, ?, 0, ?)
            `).run(ticker, userId, shares, totalValue, now);

            // 9. Record in lax_transactions audit log
            const txId = generateTxId('tx_sell');
            await tx.prepare(`
                INSERT INTO lax_transactions
                (transaction_id, transaction_type, user_id, ticker, shares, price_per_share, total_value, acquisition_cost, realized_pnl, resulting_lax_balance, resulting_treasury_shares, timestamp)
                VALUES (?, 'INSTANT_SELL', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            `).run(
                txId,
                userId,
                ticker,
                shares,
                buybackPrice,
                totalValue,
                totalValue,
                resultingLaxBalance,
                newTreasuryShares,
                now
            );

            return {
                success: true,
                txId,
                ticker,
                companyName: company.company_name,
                sharesSold: shares,
                buybackPrice,
                totalTokensReceived: totalValue,
                newMarketPrice: newPrice,
                newUserBalance: userRecord.wallet_tokens + totalValue,
                resultingLaxBalance,
                resultingTreasuryShares: newTreasuryShares,
                cooldownExpiresAt: now + INSTANT_SELL_COOLDOWN_MS,
            };
        });
    } finally {
        inFlightUsers.delete(userId);
    }
}

/**
 * Fulfills shares from LAX Treasury inventory during stock purchase.
 * Deducts FIFO lots, calculates realized PnL, updates LAX balance & treasury records.
 */
async function fulfillFromTreasury(tx, { ticker, requestedShares, currentPrice, tradeTimestamp, buyerId }) {
    ticker = ticker.toUpperCase();
    const treasury = await tx.prepare('SELECT * FROM lax_treasury WHERE ticker = ?').get(ticker);
    if (!treasury || treasury.shares <= 0 || requestedShares <= 0) {
        return {
            sharesFilled: 0,
            grossValue: 0,
            feeAmount: 0,
            netProceeds: 0,
            acquisitionCost: 0,
            realizedPnL: 0,
        };
    }

    const fillCount = Math.min(requestedShares, treasury.shares);
    const grossValue = Number((fillCount * currentPrice).toFixed(8));
    const feeAmount = calculateExchangeFee(grossValue);
    const netProceeds = Number((grossValue - feeAmount).toFixed(8));

    // Consume FIFO lots to determine exact acquisition cost
    const lots = await tx.prepare(
        "SELECT * FROM lax_treasury_lots WHERE ticker = ? AND status = 'active' AND shares > 0 ORDER BY timestamp ASC, id ASC"
    ).all(ticker);

    let remainingToDeduct = fillCount;
    let totalAcquisitionCost = 0;

    for (const lot of lots) {
        if (remainingToDeduct <= 0) break;
        const takeFromLot = Math.min(remainingToDeduct, lot.shares);
        const lotCostPortion = Number((takeFromLot * lot.unit_cost).toFixed(8));
        totalAcquisitionCost += lotCostPortion;
        remainingToDeduct -= takeFromLot;

        const newLotShares = lot.shares - takeFromLot;
        const newStatus = newLotShares === 0 ? 'exhausted' : 'active';
        await tx.prepare('UPDATE lax_treasury_lots SET shares = ?, status = ? WHERE id = ?')
            .run(newLotShares, newStatus, lot.id);
    }

    totalAcquisitionCost = Number(totalAcquisitionCost.toFixed(8));
    // Realized Profit/Loss = net proceeds received by LAX minus acquisition cost of those shares
    const realizedPnL = Number((netProceeds - totalAcquisitionCost).toFixed(8));

    const newTreasuryShares = treasury.shares - fillCount;
    const newTotalAcquisitionCost = Math.max(0, Number((treasury.total_acquisition_cost - totalAcquisitionCost).toFixed(8)));

    // Update LAX Treasury Inventory
    await tx.prepare('UPDATE lax_treasury SET shares = ?, total_acquisition_cost = ?, updated_at = ? WHERE ticker = ?')
        .run(newTreasuryShares, newTotalAcquisitionCost, tradeTimestamp, ticker);

    // Update LAX Accounting Balance & Realized PnL
    await tx.prepare('UPDATE lax_account SET balance = balance + ?, realized_pnl = realized_pnl + ? WHERE id = 1')
        .run(netProceeds, realizedPnL);

    const updatedAccount = await tx.prepare('SELECT balance FROM lax_account WHERE id = 1').get();
    const resultingLaxBalance = updatedAccount?.balance ?? 0;

    // Log Treasury Sale in lax_transactions
    const txId = generateTxId('tx_tr_buy');
    await tx.prepare(`
        INSERT INTO lax_transactions
        (transaction_id, transaction_type, user_id, ticker, shares, price_per_share, total_value, acquisition_cost, realized_pnl, resulting_lax_balance, resulting_treasury_shares, timestamp)
        VALUES (?, 'TREASURY_SALE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        txId,
        buyerId,
        ticker,
        fillCount,
        currentPrice,
        grossValue,
        totalAcquisitionCost,
        realizedPnL,
        resultingLaxBalance,
        newTreasuryShares,
        tradeTimestamp
    );

    // Record trade in trade_ledger
    await tx.prepare(`
        INSERT INTO trade_ledger (ticker, buyer_id, seller_id, shares, trade_value, fee_amount, timestamp)
        VALUES (?, ?, 'LAX_TREASURY', ?, ?, ?, ?)
    `).run(ticker, buyerId, fillCount, grossValue, feeAmount, tradeTimestamp);

    return {
        sharesFilled: fillCount,
        grossValue,
        feeAmount,
        netProceeds,
        acquisitionCost: totalAcquisitionCost,
        realizedPnL,
        resultingLaxBalance,
        resultingTreasuryShares: newTreasuryShares,
    };
}

/**
 * Updates configurable debt floor.
 */
async function setDebtFloor(db, newFloor) {
    if (typeof newFloor !== 'number' || isNaN(newFloor) || newFloor > 0) {
        return { success: false, error: 'Debt floor must be a negative number or zero (e.g. -10000).' };
    }
    await getLaxAccount(db);
    await db.prepare('UPDATE lax_account SET debt_floor = ? WHERE id = 1').run(newFloor);
    return { success: true, debtFloor: newFloor };
}

/**
 * Toggles or sets the global Instant Sell kill switch.
 */
async function setKillSwitch(db, enabled) {
    const val = enabled ? 1 : 0;
    await getLaxAccount(db);
    await db.prepare('UPDATE lax_account SET kill_switch_enabled = ? WHERE id = 1').run(val);
    return { success: true, killSwitchEnabled: Boolean(val) };
}

/**
 * Allows the exchange owner to withdraw realized profit.
 */
async function withdrawRealizedProfit(db, { ownerId, amount }) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        return { success: false, error: 'Please specify a valid positive amount of profit to withdraw.' };
    }

    return await db.transaction(async (tx) => {
        const account = await getLaxAccount(tx);
        const withdrawable = account.withdrawable_profit;

        if (amount > withdrawable) {
            return {
                success: false,
                error: `Cannot withdraw ${fmt(amount)} tokens. Maximum withdrawable realized profit is **${fmt(withdrawable)} tokens**.`,
            };
        }

        const now = Date.now();
        await tx.prepare('UPDATE lax_account SET total_withdrawn = total_withdrawn + ? WHERE id = 1').run(amount);
        await tx.prepare('INSERT OR IGNORE INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, 0, ?)').run(ownerId, '{}');
        await tx.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?').run(amount, ownerId);

        const txId = generateTxId('tx_withdr');
        await tx.prepare(`
            INSERT INTO lax_transactions
            (transaction_id, transaction_type, user_id, ticker, shares, price_per_share, total_value, acquisition_cost, realized_pnl, resulting_lax_balance, resulting_treasury_shares, timestamp)
            VALUES (?, 'PROFIT_WITHDRAWAL', ?, NULL, 0, 0, ?, 0, 0, ?, 0, ?)
        `).run(txId, ownerId, amount, account.balance, now);

        return {
            success: true,
            txId,
            withdrawnAmount: amount,
            remainingWithdrawable: withdrawable - amount,
        };
    });
}

module.exports = {
    MAX_INSTANT_SELL_VALUE,
    INSTANT_SELL_COOLDOWN_MS,
    DEFAULT_DEBT_FLOOR,
    fmt,
    generateTxId,
    getLaxAccount,
    getTreasuryInventory,
    getCooldown,
    validateInstantSell,
    executeInstantSell,
    fulfillFromTreasury,
    setDebtFloor,
    setKillSwitch,
    withdrawRealizedProfit,
};

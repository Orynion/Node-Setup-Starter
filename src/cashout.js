const MAX_CASHOUT_AMOUNT = 8000;

function fmt(n) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Validates a cashout request amount against limits and user balance.
 */
function validateCashoutAmount(amount, userBalance) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        return { valid: false, reason: 'Please specify a valid positive token amount.' };
    }

    if (amount > MAX_CASHOUT_AMOUNT) {
        return {
            valid: false,
            reason: `Maximum cashout limit is **${MAX_CASHOUT_AMOUNT.toLocaleString()} tokens** per request.`,
        };
    }

    if (userBalance < amount) {
        return {
            valid: false,
            reason: `Insufficient balance. You requested **${fmt(amount)} tokens**, but your available balance is only **${fmt(userBalance)} tokens**.`,
        };
    }

    return { valid: true };
}

/**
 * Creates a pending cashout request in the database.
 * Does NOT deduct user balance at this time.
 */
async function createCashoutRequest(db, { userId, amount, channelId }) {
    const user = await db.prepare('SELECT * FROM users WHERE discord_id = ?').get(userId);
    const balance = user ? user.wallet_tokens : 0;

    const validation = validateCashoutAmount(amount, balance);
    if (!validation.valid) {
        return { success: false, error: validation.reason };
    }

    const now = Date.now();
    const result = await db.prepare(
        `INSERT INTO cashout_requests (user_id, amount, status, channel_id, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`
    ).run(userId, amount, channelId || null, now, now);

    return {
        success: true,
        requestId: result.lastInsertRowid,
        userId,
        amount,
        userBalance: balance,
        status: 'pending',
        createdAt: now,
    };
}

/**
 * Approves and completes a pending cashout request atomically:
 * 1. Checks that admin is not self-approving.
 * 2. Re-verifies that request is still 'pending'.
 * 3. Re-verifies user's current balance >= request amount (prevents overdraft if balance changed).
 * 4. Deducts tokens from user wallet.
 * 5. Updates request status to 'completed'.
 */
async function approveCashoutRequest(db, { requestId, adminId }) {
    return await db.transaction(async (tx) => {
        const req = await tx.prepare('SELECT * FROM cashout_requests WHERE id = ?').get(requestId);
        if (!req) {
            return { success: false, error: `Cashout request #${requestId} not found.` };
        }

        if (adminId && req.user_id === adminId) {
            return { success: false, error: 'Unauthorized: You cannot approve your own cashout request.' };
        }

        if (req.status !== 'pending') {
            return {
                success: false,
                error: `This cashout request is already **${req.status}** by <@${req.admin_id || 'an admin'}> and cannot be processed again.`,
            };
        }

        const user = await tx.prepare('SELECT * FROM users WHERE discord_id = ?').get(req.user_id);
        if (!user) {
            return { success: false, error: 'User not found.' };
        }

        if (user.wallet_tokens < req.amount) {
            return {
                success: false,
                error: `Insufficient balance: User only has **${fmt(user.wallet_tokens)} tokens** available, but requested **${fmt(req.amount)} tokens**. Cashout cancelled to prevent overdraw.`,
            };
        }

        // Deduct balance atomically
        await tx.prepare('UPDATE users SET wallet_tokens = wallet_tokens - ? WHERE discord_id = ?')
            .run(req.amount, req.user_id);

        const now = Date.now();
        await tx.prepare(
            `UPDATE cashout_requests
             SET status = 'completed', admin_id = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`
        ).run(adminId || null, now, requestId);

        const remainingBalance = user.wallet_tokens - req.amount;

        return {
            success: true,
            req,
            deductedAmount: req.amount,
            remainingBalance,
            completedAt: now,
        };
    });
}

/**
 * Rejects a pending cashout request:
 * 1. Re-verifies that request is still 'pending'.
 * 2. Updates request status to 'rejected'.
 * 3. Leaves user balance completely untouched.
 */
async function rejectCashoutRequest(db, { requestId, adminId, reason }) {
    return await db.transaction(async (tx) => {
        const req = await tx.prepare('SELECT * FROM cashout_requests WHERE id = ?').get(requestId);
        if (!req) {
            return { success: false, error: `Cashout request #${requestId} not found.` };
        }

        if (req.status !== 'pending') {
            return {
                success: false,
                error: `This cashout request is already **${req.status}** and cannot be modified.`,
            };
        }

        const now = Date.now();
        await tx.prepare(
            `UPDATE cashout_requests
             SET status = 'rejected', admin_id = ?, admin_note = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`
        ).run(adminId || null, reason || null, now, requestId);

        return {
            success: true,
            req,
            rejectedAt: now,
        };
    });
}

module.exports = {
    MAX_CASHOUT_AMOUNT,
    validateCashoutAmount,
    createCashoutRequest,
    approveCashoutRequest,
    rejectCashoutRequest,
    fmt,
};

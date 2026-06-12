const { Client, GatewayIntentBits, Events, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { createCanvas } = require('canvas');
require('dotenv').config();
const db = require('./database.js');
const { registerCommands } = require('./deploy-commands.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOrCreateUser(userId) {
    let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(userId);
    if (!user) {
        db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, 0, ?)').run(userId, '{}');
        user = { discord_id: userId, wallet_tokens: 0, portfolio: '{}' };
    }
    return user;
}

function isAdmin(interaction) {
    return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
}

function fmt(n) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function recordPrice(ticker, price) {
    db.prepare('INSERT INTO price_history (ticker, price, timestamp) VALUES (?, ?, ?)').run(ticker, price, Date.now());
}

function adjustPrice(current, shares, direction) {
    const factor = direction === 'up' ? 1.001 : 0.999;
    return Math.max(0.01, parseFloat((current * Math.pow(factor, shares)).toFixed(2)));
}

function getPortfolio(user) {
    try { return JSON.parse(user.portfolio); } catch { return {}; }
}

function generateChartBuffer(prices, timestamps, companyName) {
    const W = 800, H = 400;
    const PAD = { top: 60, right: 40, bottom: 55, left: 80 };
    const cW = W - PAD.left - PAD.right;
    const cH = H - PAD.top - PAD.bottom;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#161b22';
    ctx.fillRect(PAD.left, PAD.top, cW, cH);

    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const pRange = maxP - minP || 0.01;
    const pad = pRange * 0.1;
    const yMin = minP - pad, yMax = maxP + pad, yRange = yMax - yMin;

    const xOf = i => PAD.left + (i / (prices.length - 1)) * cW;
    const yOf = p => PAD.top + cH - ((p - yMin) / yRange) * cH;

    // Gridlines
    const yTicks = 5;
    ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    for (let i = 0; i <= yTicks; i++) {
        const y = PAD.top + (i / yTicks) * cH;
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Area fill
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(prices[0]));
    for (let i = 1; i < prices.length; i++) ctx.lineTo(xOf(i), yOf(prices[i]));
    ctx.lineTo(xOf(prices.length - 1), PAD.top + cH);
    ctx.lineTo(xOf(0), PAD.top + cH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    grad.addColorStop(0, 'rgba(0, 255, 136, 0.25)');
    grad.addColorStop(1, 'rgba(0, 255, 136, 0.02)');
    ctx.fillStyle = grad; ctx.fill();

    // Price line
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(prices[0]));
    for (let i = 1; i < prices.length; i++) ctx.lineTo(xOf(i), yOf(prices[i]));
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();

    // Last dot
    const lastX = xOf(prices.length - 1), lastY = yOf(prices[prices.length - 1]);
    ctx.beginPath(); ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88'; ctx.fill();
    ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2; ctx.stroke();

    // Y axis labels
    ctx.fillStyle = '#8b949e'; ctx.font = '12px sans-serif'; ctx.textAlign = 'right';
    for (let i = 0; i <= yTicks; i++) {
        const p = yMax - (i / yTicks) * yRange;
        ctx.fillText(`$${fmt(p)}`, PAD.left - 8, PAD.top + (i / yTicks) * cH + 4);
    }

    // X axis labels
    ctx.textAlign = 'center';
    const xLabelCount = Math.min(5, prices.length);
    for (let i = 0; i < xLabelCount; i++) {
        const idx = Math.round((i / (xLabelCount - 1)) * (prices.length - 1));
        const d = new Date(timestamps[idx]);
        const label = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        ctx.fillStyle = '#8b949e'; ctx.font = '12px sans-serif';
        ctx.fillText(label, xOf(idx), PAD.top + cH + 20);
    }

    // Border
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
    ctx.strokeRect(PAD.left, PAD.top, cW, cH);

    // Title
    ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(companyName, PAD.left, 38);

    // Change badge
    const priceChange = prices[prices.length - 1] - prices[0];
    const pct = ((priceChange / prices[0]) * 100).toFixed(2);
    ctx.fillStyle = priceChange >= 0 ? '#00ff88' : '#ff4444';
    ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`${priceChange >= 0 ? '▲' : '▼'} ${fmt(Math.abs(priceChange))}  (${pct}%)`, W - PAD.right, 38);

    // Current price at dot
    ctx.fillStyle = '#00ff88'; ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = lastX > W - 100 ? 'right' : 'left';
    ctx.fillText(`$${fmt(prices[prices.length - 1])}`, lastX + (lastX > W - 100 ? -10 : 10), lastY - 8);

    return canvas.toBuffer('image/png');
}

function buildPriceChart(prices, timestamps) {
    const H = 8;
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 0.01;
    const toRow = p => H - 1 - Math.round(((p - minP) / range) * (H - 1));
    const dataRows = prices.map(toRow);
    const n = prices.length;
    const totalCols = 2 * n - 1;

    const grid = Array.from({ length: H }, () => Array(totalCols).fill(' '));

    for (let i = 0; i < n; i++) grid[dataRows[i]][i * 2] = '●';

    for (let i = 0; i < n - 1; i++) {
        const r1 = dataRows[i], r2 = dataRows[i + 1], cc = i * 2 + 1;
        if (r1 === r2) {
            grid[r1][cc] = '─';
        } else if (r2 < r1) {
            grid[r1][cc] = '╯';
            for (let r = r2 + 1; r < r1; r++) grid[r][cc] = '│';
        } else {
            grid[r1][cc] = '╮';
            for (let r = r1 + 1; r < r2; r++) grid[r][cc] = '│';
        }
    }

    const labelRows = new Set([0, Math.floor(H / 4), Math.floor(H / 2), Math.floor(3 * H / 4), H - 1]);
    const lines = grid.map((row, i) => {
        const price = maxP - (i / (H - 1)) * range;
        const label = labelRows.has(i) ? `$${price.toFixed(2)}`.padStart(8) : ' '.repeat(8);
        return `${label} ┤${row.join('')}`;
    });

    lines.push(`         └${'─'.repeat(totalCols)}`);

    const fmtT = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
    const t1 = fmtT(timestamps[0]);
    const tm = fmtT(timestamps[Math.floor(n / 2)]);
    const tN = fmtT(timestamps[n - 1]);
    const mid = Math.floor(totalCols / 2);
    const sp1 = Math.max(1, mid - t1.length);
    const sp2 = Math.max(1, totalCols - mid - tm.length - tN.length + 1);
    lines.push(`          ${t1}${' '.repeat(sp1)}${tm}${' '.repeat(sp2)}${tN}`);

    return lines.join('\n');
}

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
    console.log('Bot is online!');
    console.log('Database ready!');
    await registerCommands();
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {

        // ── /balance ──────────────────────────────────────────────────────────
        if (commandName === 'balance') {
            const user = getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(user);
            const entries = Object.entries(portfolio);

            let portfolioText = entries.length === 0
                ? 'No stocks owned.'
                : entries.map(([t, s]) => `**${t}**: ${s} share${s !== 1 ? 's' : ''}`).join('\n');

            return interaction.reply({
                embeds: [{
                    title: `💰 ${interaction.user.username}'s Balance`,
                    fields: [
                        { name: 'Wallet Tokens', value: `${fmt(user.wallet_tokens)} tokens`, inline: false },
                        { name: 'Stock Portfolio', value: portfolioText, inline: false },
                    ],
                    color: 0x5865F2,
                }]
            });
        }

        // ── /admin-add-money ──────────────────────────────────────────────────
        if (commandName === 'admin-add-money') {
            if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

            const target = interaction.options.getUser('user');
            const amount = interaction.options.getNumber('amount');
            getOrCreateUser(target.id);
            db.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?').run(amount, target.id);

            return interaction.reply({
                embeds: [{
                    title: '✅ Tokens Added',
                    description: `Added **${fmt(amount)} tokens** to **${target.username}**.`,
                    color: 0x57F287,
                }]
            });
        }

        // ── /admin-remove-money ───────────────────────────────────────────────
        if (commandName === 'admin-remove-money') {
            if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

            const target = interaction.options.getUser('user');
            const amount = interaction.options.getNumber('amount');
            getOrCreateUser(target.id);
            db.prepare('UPDATE users SET wallet_tokens = MAX(0, wallet_tokens - ?) WHERE discord_id = ?').run(amount, target.id);

            return interaction.reply({
                embeds: [{
                    title: '✅ Tokens Removed',
                    description: `Removed **${fmt(amount)} tokens** from **${target.username}**.`,
                    color: 0xED4245,
                }]
            });
        }

        // ── /leaderboard ──────────────────────────────────────────────────────
        if (commandName === 'leaderboard') {
            const top = db.prepare('SELECT discord_id, wallet_tokens FROM users ORDER BY wallet_tokens DESC LIMIT 10').all();

            if (top.length === 0) return interaction.reply({ content: 'No users found.', ephemeral: true });

            const medals = ['🥇', '🥈', '🥉'];
            const lines = await Promise.all(top.map(async (u, i) => {
                let name;
                try {
                    const member = await interaction.guild.members.fetch(u.discord_id);
                    name = member.displayName;
                } catch {
                    name = `User ${u.discord_id.slice(-4)}`;
                }
                const medal = medals[i] ?? `**${i + 1}.**`;
                return `${medal} ${name} — ${fmt(u.wallet_tokens)} tokens`;
            }));

            return interaction.reply({
                embeds: [{
                    title: '🏆 Token Leaderboard',
                    description: lines.join('\n'),
                    color: 0xFEE75C,
                }]
            });
        }

        // ── /stock-buy ────────────────────────────────────────────────────────
        if (commandName === 'stock-buy') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const amount = interaction.options.getInteger('amount');

            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const buyer = getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(buyer);

            const sellOrders = db.prepare(
                'SELECT * FROM sell_orders WHERE ticker = ? AND seller_id != ? ORDER BY list_price ASC, timestamp ASC'
            ).all(ticker, interaction.user.id);

            let remaining = amount;
            let totalCost = 0;
            const ordersToFill = [];
            let sharesFromBot = 0;

            for (const order of sellOrders) {
                if (remaining <= 0) break;
                const fill = Math.min(order.shares, remaining);
                totalCost += fill * order.list_price;
                ordersToFill.push({ order, fill });
                remaining -= fill;
            }

            if (remaining > 0) {
                if (company.bot_share_reserve < remaining)
                    return interaction.reply({ content: `Not enough shares available. Bot reserve: **${company.bot_share_reserve}**, sell orders available: **${amount - remaining}**.`, ephemeral: true });
                totalCost += remaining * company.current_price;
                sharesFromBot = remaining;
            }

            if (buyer.wallet_tokens < totalCost)
                return interaction.reply({ content: `Insufficient tokens. Need **${fmt(totalCost)}**, you have **${fmt(buyer.wallet_tokens)}**.`, ephemeral: true });

            // Process sell orders
            for (const { order, fill } of ordersToFill) {
                getOrCreateUser(order.seller_id);
                db.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?').run(fill * order.list_price, order.seller_id);
                if (fill === order.shares) {
                    db.prepare('DELETE FROM sell_orders WHERE id = ?').run(order.id);
                } else {
                    db.prepare('UPDATE sell_orders SET shares = shares - ? WHERE id = ?').run(fill, order.id);
                }
            }

            // Process bot pool shares
            let newPrice = company.current_price;
            if (sharesFromBot > 0) {
                const ownerEarnings = sharesFromBot * company.current_price;
                newPrice = adjustPrice(company.current_price, sharesFromBot, 'up');
                db.prepare(`UPDATE companies SET
                    bot_share_reserve = bot_share_reserve - ?,
                    shares_in_circulation = shares_in_circulation + ?,
                    current_price = ?,
                    pending_cashout_tokens = pending_cashout_tokens + ?,
                    all_time_earnings = all_time_earnings + ?
                    WHERE ticker = ?`
                ).run(sharesFromBot, sharesFromBot, newPrice, ownerEarnings, ownerEarnings, ticker);
                getOrCreateUser(company.owner_id);
                db.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?').run(ownerEarnings, company.owner_id);
                recordPrice(ticker, newPrice);
            }

            // Deduct buyer tokens and update portfolio
            portfolio[ticker] = (portfolio[ticker] || 0) + amount;
            db.prepare('UPDATE users SET wallet_tokens = wallet_tokens - ?, portfolio = ? WHERE discord_id = ?')
                .run(totalCost, JSON.stringify(portfolio), interaction.user.id);

            const sharesFromOrders = amount - sharesFromBot;
            return interaction.reply({
                embeds: [{
                    title: `📈 Bought ${amount} shares of ${ticker}`,
                    fields: [
                        { name: 'Total Cost', value: `${fmt(totalCost)} tokens`, inline: true },
                        { name: 'New Price', value: `${fmt(newPrice)} tokens`, inline: true },
                        { name: 'From Sellers', value: `${sharesFromOrders} shares`, inline: true },
                        { name: 'From Bot Reserve', value: `${sharesFromBot} shares`, inline: true },
                    ],
                    color: 0x57F287,
                }]
            });
        }

        // ── /stock-sell ───────────────────────────────────────────────────────
        if (commandName === 'stock-sell') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const amount = interaction.options.getInteger('amount');

            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const user = getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(user);
            const owned = portfolio[ticker] || 0;

            if (owned < amount)
                return interaction.reply({ content: `You only own **${owned}** shares of **${ticker}**.`, ephemeral: true });

            // Remove from portfolio
            portfolio[ticker] = owned - amount;
            if (portfolio[ticker] === 0) delete portfolio[ticker];
            db.prepare('UPDATE users SET portfolio = ? WHERE discord_id = ?').run(JSON.stringify(portfolio), interaction.user.id);

            // Create sell order at current price
            const listPrice = company.current_price;
            db.prepare('INSERT INTO sell_orders (seller_id, ticker, shares, list_price, timestamp) VALUES (?, ?, ?, ?, ?)')
                .run(interaction.user.id, ticker, amount, listPrice, Date.now());

            // Price goes down
            const newPrice = adjustPrice(company.current_price, amount, 'down');
            db.prepare('UPDATE companies SET current_price = ? WHERE ticker = ?').run(newPrice, ticker);
            recordPrice(ticker, newPrice);

            return interaction.reply({
                embeds: [{
                    title: `📉 Listed ${amount} shares of ${ticker}`,
                    fields: [
                        { name: 'List Price', value: `${fmt(listPrice)} tokens/share`, inline: true },
                        { name: 'New Market Price', value: `${fmt(newPrice)} tokens`, inline: true },
                        { name: 'Total if Sold', value: `${fmt(listPrice * amount)} tokens`, inline: true },
                    ],
                    description: 'You will be paid when a buyer purchases your shares.',
                    color: 0xFEE75C,
                }]
            });
        }

        // ── /sell-cancel ──────────────────────────────────────────────────────
        if (commandName === 'sell-cancel') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const cancelAmount = interaction.options.getInteger('amount') ?? null;

            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const orders = db.prepare(
                'SELECT * FROM sell_orders WHERE seller_id = ? AND ticker = ? ORDER BY timestamp ASC'
            ).all(interaction.user.id, ticker);

            if (orders.length === 0)
                return interaction.reply({ content: `You have no active sell listings for **${ticker}**.`, ephemeral: true });

            const totalListed = orders.reduce((s, o) => s + o.shares, 0);
            const toCancel = cancelAmount !== null ? Math.min(cancelAmount, totalListed) : totalListed;

            if (toCancel <= 0)
                return interaction.reply({ content: `Nothing to cancel.`, ephemeral: true });

            // Remove orders oldest-first up to toCancel shares
            let remaining = toCancel;
            for (const order of orders) {
                if (remaining <= 0) break;
                if (order.shares <= remaining) {
                    db.prepare('DELETE FROM sell_orders WHERE id = ?').run(order.id);
                    remaining -= order.shares;
                } else {
                    db.prepare('UPDATE sell_orders SET shares = shares - ? WHERE id = ?').run(remaining, order.id);
                    remaining = 0;
                }
            }

            // Return shares to portfolio
            const user = getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(user);
            portfolio[ticker] = (portfolio[ticker] || 0) + toCancel;
            db.prepare('UPDATE users SET portfolio = ? WHERE discord_id = ?').run(JSON.stringify(portfolio), interaction.user.id);

            // Price goes back up (reverse of listing)
            const newPrice = adjustPrice(company.current_price, toCancel, 'up');
            db.prepare('UPDATE companies SET current_price = ? WHERE ticker = ?').run(newPrice, ticker);
            recordPrice(ticker, newPrice);

            const stillListed = totalListed - toCancel;
            return interaction.reply({
                embeds: [{
                    title: `✅ Cancelled ${toCancel} sell listing${toCancel !== 1 ? 's' : ''} for ${ticker}`,
                    fields: [
                        { name: 'Shares Returned', value: `${toCancel}`, inline: true },
                        { name: 'Still Listed', value: `${stillListed}`, inline: true },
                        { name: 'New Market Price', value: `${fmt(newPrice)} tokens`, inline: true },
                    ],
                    color: 0x57F287,
                }],
                ephemeral: true,
            });
        }

        // ── /stock-info ───────────────────────────────────────────────────────
        if (commandName === 'stock-info') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const marketCap = company.current_price * company.shares_in_circulation;
            const sellOrderCount = db.prepare('SELECT COUNT(*) as cnt, SUM(shares) as total FROM sell_orders WHERE ticker = ?').get(ticker);
            const emoji = company.emoji ?? '🏢';

            const history = db.prepare('SELECT price, timestamp FROM price_history WHERE ticker = ? ORDER BY timestamp DESC LIMIT 60').all(ticker);
            history.reverse();
            const prices = history.map(h => h.price);
            const timestamps = history.map(h => h.timestamp);
            const hasChart = prices.length >= 2;

            const embedData = {
                title: `${emoji} ${company.company_name} (${ticker})`,
                fields: [
                    { name: 'Current Price', value: `${fmt(company.current_price)} tokens`, inline: true },
                    { name: 'IPO Price', value: `${fmt(company.ipo_share_price)} tokens`, inline: true },
                    { name: 'Market Cap', value: `${fmt(marketCap)} tokens`, inline: true },
                    { name: 'Total Supply', value: `${company.total_supply.toLocaleString()}`, inline: true },
                    { name: 'In Circulation', value: `${company.shares_in_circulation.toLocaleString()}`, inline: true },
                    { name: 'Bot Reserve', value: `${company.bot_share_reserve.toLocaleString()}`, inline: true },
                    { name: 'Sell Orders', value: `${sellOrderCount.cnt} orders (${sellOrderCount.total || 0} shares)`, inline: true },
                ],
                color: 0x5865F2,
            };

            if (!hasChart) {
                return interaction.reply({ embeds: [embedData] });
            }

            await interaction.deferReply();
            const buf = generateChartBuffer(prices, timestamps, company.company_name);
            const attachment = new AttachmentBuilder(buf, { name: `${ticker}-info.png` });
            embedData.image = { url: `attachment://${ticker}-info.png` };

            return interaction.editReply({ embeds: [embedData], files: [attachment] });
        }

        // ── /stock-list ───────────────────────────────────────────────────────
        if (commandName === 'stock-list') {
            const companies = db.prepare('SELECT * FROM companies ORDER BY current_price DESC').all();
            if (companies.length === 0) return interaction.reply({ content: 'No companies listed yet.', ephemeral: true });

            const lines = companies.map(c => {
                const change = ((c.current_price - c.ipo_share_price) / c.ipo_share_price * 100).toFixed(1);
                const arrow = c.current_price >= c.ipo_share_price ? '📈' : '📉';
                return `${arrow} **${c.ticker}** — ${c.company_name}\n  Price: **${fmt(c.current_price)}** tokens (${change}% from IPO) | Reserve: ${c.bot_share_reserve}`;
            });

            return interaction.reply({
                embeds: [{
                    title: '🏢 Listed Companies',
                    description: lines.join('\n\n'),
                    color: 0x5865F2,
                }]
            });
        }

        // ── /chart ────────────────────────────────────────────────────────────
        if (commandName === 'chart') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const history = db.prepare('SELECT price, timestamp FROM price_history WHERE ticker = ? ORDER BY timestamp DESC LIMIT 60').all(ticker);

            if (history.length < 2)
                return interaction.reply({ content: `Not enough price history for **${ticker}** yet. Buy or sell some shares first!`, ephemeral: true });

            await interaction.deferReply();

            history.reverse();
            const prices = history.map(h => h.price);
            const timestamps = history.map(h => h.timestamp);

            const priceChange = prices[prices.length - 1] - prices[0];
            const pct = ((priceChange / prices[0]) * 100).toFixed(2);
            const emoji = company.emoji ?? '🏢';
            const buf = generateChartBuffer(prices, timestamps, company.company_name);
            const attachment = new AttachmentBuilder(buf, { name: `${ticker}-chart.png` });

            return interaction.editReply({
                embeds: [{
                    title: `${emoji} ${company.company_name} (${ticker}) — Price Chart`,
                    fields: [
                        { name: 'Open', value: `${fmt(prices[0])} tokens`, inline: true },
                        { name: 'Current', value: `${fmt(company.current_price)} tokens`, inline: true },
                        { name: 'Change', value: `${priceChange >= 0 ? '+' : ''}${fmt(priceChange)} (${pct}%)`, inline: true },
                        { name: 'Low', value: `${fmt(Math.min(...prices))} tokens`, inline: true },
                        { name: 'High', value: `${fmt(Math.max(...prices))} tokens`, inline: true },
                        { name: 'Data Points', value: `${prices.length} trades`, inline: true },
                    ],
                    image: { url: `attachment://${ticker}-chart.png` },
                    color: priceChange >= 0 ? 0x57F287 : 0xED4245,
                }],
                files: [attachment],
            });
        }

        // ── /admin-removecompany ──────────────────────────────────────────────
        if (commandName === 'admin-removecompany') {
            if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const confirm = interaction.options.getString('confirm') ?? 'yes';

            if (confirm === 'no')
                return interaction.reply({ content: `❌ Removal of **${ticker}** cancelled.`, ephemeral: true });

            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            db.prepare('DELETE FROM companies WHERE ticker = ?').run(ticker);
            db.prepare('DELETE FROM price_history WHERE ticker = ?').run(ticker);
            db.prepare('DELETE FROM sell_orders WHERE ticker = ?').run(ticker);

            return interaction.reply({
                embeds: [{
                    title: '🗑️ Company Removed',
                    description: `**${company.company_name} (${ticker})** has been deleted along with its price history and open sell orders.`,
                    color: 0xED4245,
                }]
            });
        }

        // ── /admin-editcompany ────────────────────────────────────────────────
        if (commandName === 'admin-editcompany') {
            if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const newName  = interaction.options.getString('name')   ?? company.company_name;
            const newOwner = interaction.options.getUser('owner');
            const newPrice = interaction.options.getNumber('price')  ?? company.current_price;
            const newEmoji = interaction.options.getString('emoji')  ?? company.emoji ?? '🏢';
            const ownerId  = newOwner ? newOwner.id : company.owner_id;

            db.prepare(`UPDATE companies SET company_name = ?, owner_id = ?, current_price = ?, emoji = ? WHERE ticker = ?`)
                .run(newName, ownerId, newPrice, newEmoji, ticker);

            if (newPrice !== company.current_price) recordPrice(ticker, newPrice);

            const changes = [];
            if (newName !== company.company_name)   changes.push(`Name → **${newName}**`);
            if (ownerId !== company.owner_id)        changes.push(`Owner → **${newOwner.username}**`);
            if (newPrice !== company.current_price) changes.push(`Price → **${fmt(newPrice)}** tokens`);
            if (newEmoji !== (company.emoji ?? '🏢')) changes.push(`Emoji → ${newEmoji}`);

            return interaction.reply({
                embeds: [{
                    title: `${newEmoji} ${newName} (${ticker}) Updated`,
                    description: changes.length ? changes.join('\n') : 'No changes made.',
                    color: 0x5865F2,
                }]
            });
        }

        // ── /admin-addcompany ─────────────────────────────────────────────────
        if (commandName === 'admin-addcompany') {
            if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const name = interaction.options.getString('name');
            const owner = interaction.options.getUser('owner');
            const price = interaction.options.getNumber('price');
            const supply = interaction.options.getInteger('supply');
            const emoji = interaction.options.getString('emoji') ?? '🏢';

            const existing = db.prepare('SELECT ticker FROM companies WHERE ticker = ?').get(ticker);
            if (existing) return interaction.reply({ content: `Company **${ticker}** already exists.`, ephemeral: true });

            db.prepare(`INSERT INTO companies
                (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve, pending_cashout_tokens, all_time_earnings, emoji)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?)
            `).run(ticker, name, owner.id, price, price, supply, supply, emoji);

            recordPrice(ticker, price);

            return interaction.reply({
                embeds: [{
                    title: `${emoji} New Company Listed!`,
                    fields: [
                        { name: 'Ticker', value: ticker, inline: true },
                        { name: 'Name', value: name, inline: true },
                        { name: 'IPO Price', value: `${fmt(price)} tokens`, inline: true },
                        { name: 'Total Supply', value: supply.toLocaleString(), inline: true },
                        { name: 'Owner', value: owner.username, inline: true },
                    ],
                    color: 0x57F287,
                }]
            });
        }

        // ── /earnings ─────────────────────────────────────────────────────────
        if (commandName === 'earnings') {
            const companies = db.prepare('SELECT * FROM companies WHERE owner_id = ?').all(interaction.user.id);
            if (companies.length === 0)
                return interaction.reply({ content: 'You do not own any companies.', ephemeral: true });

            const fields = companies.flatMap(c => [
                { name: `${c.ticker} — ${c.company_name}`, value: `This week: **${fmt(c.pending_cashout_tokens)}** tokens\nAll time: **${fmt(c.all_time_earnings)}** tokens`, inline: false },
            ]);

            return interaction.reply({
                embeds: [{
                    title: `💼 Your Company Earnings`,
                    fields,
                    color: 0x5865F2,
                }],
                ephemeral: true,
            });
        }

    } catch (err) {
        console.error(`Error in /${commandName}:`, err);
        const msg = { content: 'Something went wrong. Please try again.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
            interaction.followUp(msg);
        } else {
            interaction.reply(msg);
        }
    }
});

client.login(process.env.TOKEN);

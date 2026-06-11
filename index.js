const { Client, GatewayIntentBits, Events, PermissionFlagsBits } = require('discord.js');
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

        // ── /pay ──────────────────────────────────────────────────────────────
        if (commandName === 'pay') {
            const target = interaction.options.getUser('user');
            const amount = interaction.options.getNumber('amount');

            if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot pay yourself.', ephemeral: true });
            if (target.bot) return interaction.reply({ content: 'You cannot pay a bot.', ephemeral: true });

            const sender = getOrCreateUser(interaction.user.id);
            if (sender.wallet_tokens < amount) return interaction.reply({ content: `Insufficient tokens. You have **${fmt(sender.wallet_tokens)}**.`, ephemeral: true });

            getOrCreateUser(target.id);
            db.prepare('UPDATE users SET wallet_tokens = wallet_tokens - ? WHERE discord_id = ?').run(amount, interaction.user.id);
            db.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?').run(amount, target.id);

            return interaction.reply({
                embeds: [{
                    title: '💸 Transfer Complete',
                    description: `**${interaction.user.username}** sent **${fmt(amount)} tokens** to **${target.username}**.`,
                    color: 0x57F287,
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
                newPrice = adjustPrice(company.current_price, sharesFromBot, 'up');
                db.prepare(`UPDATE companies SET
                    bot_share_reserve = bot_share_reserve - ?,
                    shares_in_circulation = shares_in_circulation + ?,
                    current_price = ?,
                    pending_cashout_tokens = pending_cashout_tokens + ?,
                    all_time_earnings = all_time_earnings + ?
                    WHERE ticker = ?`
                ).run(sharesFromBot, sharesFromBot, newPrice, sharesFromBot * company.current_price, sharesFromBot * company.current_price, ticker);
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

        // ── /stock-info ───────────────────────────────────────────────────────
        if (commandName === 'stock-info') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const marketCap = company.current_price * company.shares_in_circulation;
            const sellOrderCount = db.prepare('SELECT COUNT(*) as cnt, SUM(shares) as total FROM sell_orders WHERE ticker = ?').get(ticker);

            return interaction.reply({
                embeds: [{
                    title: `📊 ${company.company_name} (${ticker})`,
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
                }]
            });
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

            const history = db.prepare('SELECT price, timestamp FROM price_history WHERE ticker = ? ORDER BY timestamp DESC LIMIT 20').all(ticker);

            if (history.length < 2) {
                return interaction.reply({ content: `Not enough price history for **${ticker}** yet. Buy or sell some shares first!`, ephemeral: true });
            }

            history.reverse();
            const prices = history.map(h => h.price);
            const min = Math.min(...prices);
            const max = Math.max(...prices);
            const range = max - min || 1;

            const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
            const sparkline = prices.map(p => {
                const idx = Math.round(((p - min) / range) * (blocks.length - 1));
                return blocks[idx];
            }).join('');

            const priceChange = prices[prices.length - 1] - prices[0];
            const pct = ((priceChange / prices[0]) * 100).toFixed(2);
            const trend = priceChange >= 0 ? '📈' : '📉';

            return interaction.reply({
                embeds: [{
                    title: `${trend} ${company.company_name} (${ticker}) Price Chart`,
                    description: `\`\`\`${sparkline}\`\`\``,
                    fields: [
                        { name: 'Low', value: `${fmt(min)} tokens`, inline: true },
                        { name: 'High', value: `${fmt(max)} tokens`, inline: true },
                        { name: 'Current', value: `${fmt(company.current_price)} tokens`, inline: true },
                        { name: 'Change', value: `${priceChange >= 0 ? '+' : ''}${fmt(priceChange)} (${pct}%)`, inline: true },
                        { name: 'Data Points', value: `${prices.length} trades`, inline: true },
                    ],
                    color: priceChange >= 0 ? 0x57F287 : 0xED4245,
                }]
            });
        }

        // ── /admin-addcompany ─────────────────────────────────────────────────
        if (commandName === 'admin-addcompany') {
            if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const name = interaction.options.getString('name');
            const price = interaction.options.getNumber('price');
            const supply = interaction.options.getInteger('supply');

            const existing = db.prepare('SELECT ticker FROM companies WHERE ticker = ?').get(ticker);
            if (existing) return interaction.reply({ content: `Company **${ticker}** already exists.`, ephemeral: true });

            db.prepare(`INSERT INTO companies
                (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve, pending_cashout_tokens, all_time_earnings)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0)
            `).run(ticker, name, interaction.user.id, price, price, supply, supply);

            recordPrice(ticker, price);

            return interaction.reply({
                embeds: [{
                    title: '🏢 New Company Listed!',
                    fields: [
                        { name: 'Ticker', value: ticker, inline: true },
                        { name: 'Name', value: name, inline: true },
                        { name: 'IPO Price', value: `${fmt(price)} tokens`, inline: true },
                        { name: 'Total Supply', value: supply.toLocaleString(), inline: true },
                        { name: 'Owner', value: interaction.user.username, inline: true },
                    ],
                    color: 0x57F287,
                }]
            });
        }

        // ── /admin-settle ─────────────────────────────────────────────────────
        if (commandName === 'admin-settle') {
            if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const company = db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.reply({ content: `Company **${ticker}** not found.`, ephemeral: true });

            const payout = company.pending_cashout_tokens;
            db.prepare('UPDATE companies SET pending_cashout_tokens = 0 WHERE ticker = ?').run(ticker);

            return interaction.reply({
                embeds: [{
                    title: `🧾 Weekly Settlement — ${ticker}`,
                    fields: [
                        { name: 'Company', value: company.company_name, inline: true },
                        { name: 'Weekly Earnings', value: `${fmt(payout)} tokens`, inline: true },
                        { name: 'All-Time Earnings', value: `${fmt(company.all_time_earnings)} tokens`, inline: true },
                        { name: 'Status', value: 'Pending cashout reset to 0 ✅', inline: false },
                    ],
                    color: 0xFEE75C,
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

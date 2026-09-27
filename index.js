const {
    Client,
    GatewayIntentBits,
    Events,
    PermissionFlagsBits,
    MessageFlags,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const zlib = require('zlib');
const { promisify } = require('util');
const express = require('express');
require('dotenv').config();
const db = require('./src/database.js');
const { registerCommands } = require('./src/deploy-commands.js');
const {
    MAX_CASHOUT_AMOUNT,
    validateCashoutAmount,
    createCashoutRequest,
    approveCashoutRequest,
    rejectCashoutRequest,
} = require('./src/cashout.js');
const treasury = require('./src/treasury.js');
const ticketUtils = require('./src/ticket-utils.js');

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => {
    res.send('Bot is running');
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Health server listening on port ${port}`);
});

const TICKET_PANEL_CHANNEL_ID = '1543951837235904512';
const TICKET_CATEGORY_NAME = '「📩」Contact Us------------------';
const OWNER_ROLE_ID = '1478001619030511747';
const REPRESENTATIVE_ROLE_ID = '1543952151364116490';
const EXCHANGE_OWNER_ID = '1416700285111505029';
const EXCHANGE_FEE_RATE = 0.01;
const TICKET_TYPES = new Map([
    ['buy_tokens', {
        slug: 'buy-tokens',
        label: 'Buy Tokens',
        description: 'Please provide the amount of tokens you want to buy and your preferred payment method.',
    }],
    ['register_company', {
        slug: 'register-company',
        label: 'Register Company',
        description: 'Please provide the company name, ticker symbol, and owner.',
    }],
    ['cashout', {
        slug: 'cashout',
        label: 'Cashout Request',
        description: 'Request a cashout for your LAX wallet tokens (Max: 8,000 tokens).',
    }],
    ['contact_us', {
        slug: 'contact-us',
        label: 'Contact Us',
        description: 'Please describe your question or general inquiry in as much detail as possible.',
    }],
]);
const closingTickets = new Set();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureInvestorRole(guild, userId) {
    if (!guild || !userId) return;
    try {
        const configuredRoleId = (process.env.INVESTOR_ROLE_ID || '').trim();
        let targetRole = null;
        if (configuredRoleId) {
            targetRole = guild.roles.cache.get(configuredRoleId) || await guild.roles.fetch(configuredRoleId).catch(() => null);
        }
        if (!targetRole) {
            targetRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'investor');
        }
        if (targetRole) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && !member.roles.cache.has(targetRole.id)) {
                await member.roles.add(targetRole.id);
                console.log(`[Investor Role] Assigned role "${targetRole.name}" (${targetRole.id}) to user ${userId} (${member.user.username}) in guild "${guild.name}".`);
            }
        }
    } catch (err) {
        console.warn(`[Investor Role] Could not assign role to user ${userId}:`, err.message);
    }
}

async function getOrCreateUser(userId) {
    let user = await db.prepare('SELECT * FROM users WHERE discord_id = ?').get(userId);
    if (!user) {
        await db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, 0, ?)').run(userId, '{}');
        user = { discord_id: userId, wallet_tokens: 0, portfolio: '{}' };
    }
    return user;
}

function isAdmin(interaction) {
    return Boolean(
        interaction.inGuild() &&
        interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)
    );
}

function fmt(n) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calculateExchangeFee(tradeValue) {
    return Number((tradeValue * EXCHANGE_FEE_RATE).toFixed(8));
}

function startOfTodayUtc() {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

async function recordPrice(ticker, price) {
    await db.prepare('INSERT INTO price_history (ticker, price, timestamp) VALUES (?, ?, ?)').run(ticker, price, Date.now());
}

function adjustPrice(current, shares, direction) {
    const factor = direction === 'up' ? 1.001 : 0.999;
    return Math.max(0.01, parseFloat((current * Math.pow(factor, shares)).toFixed(2)));
}

function getPortfolio(user) {
    try { return JSON.parse(user.portfolio); } catch { return {}; }
}

function parseEmbedColor(value) {
    if (!value) return 0x5865F2;

    const normalized = value.trim().replace(/^#/, '').replace(/^0x/i, '');
    if (!/^[\da-f]{6}$/i.test(normalized)) {
        throw new Error('Color must be a six-digit hex value, such as #5865F2.');
    }

    return parseInt(normalized, 16);
}

function validateImageUrl(value) {
    if (!value) return null;

    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Image URL must be a valid http:// or https:// URL.');
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Image URL must begin with http:// or https://.');
    }

    return url.toString();
}

function hasSupportRole(interaction) {
    return Boolean(
        interaction.inGuild() &&
        interaction.member?.roles?.cache?.some(role =>
            role.id === OWNER_ROLE_ID || role.id === REPRESENTATIVE_ROLE_ID
        )
    );
}

function ticketTopic(ticketType, userId) {
    return `ticket:${ticketType}:${userId}`;
}

function ticketChannelName(ticketType, username) {
    const safeUsername = username
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'user';
    return `${TICKET_TYPES.get(ticketType).slug}-${safeUsername}`.slice(0, 100);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleTicketButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, action, ticketType] = interaction.customId.split(':');
    if (!interaction.inGuild()) {
        return interaction.editReply({ content: 'Tickets can only be used inside a server.' });
    }

    const guild = interaction.guild;

    if (action === 'close') {
        const channel = interaction.channel;
        if (
            !channel ||
            channel.type !== ChannelType.GuildText ||
            !channel.topic?.startsWith('ticket:')
        ) {
            return interaction.editReply({ content: 'This button can only be used inside a ticket channel.' });
        }

        if (!hasSupportRole(interaction)) {
            return interaction.editReply({ content: 'Only the Owner or Representative role can close tickets.' });
        }

        if (closingTickets.has(channel.id)) {
            return interaction.editReply({ content: 'This ticket is already being closed.' });
        }

        closingTickets.add(channel.id);
        try {
            const countdown = await channel.send({
                content: '🔒 This ticket will be deleted in **5 seconds**.',
                allowedMentions: { parse: [] },
            });
            await interaction.editReply({ content: 'Ticket closing countdown started.' });

            for (let remaining = 4; remaining > 0; remaining--) {
                await sleep(1000);
                await countdown.edit({
                    content: `🔒 This ticket will be deleted in **${remaining} second${remaining === 1 ? '' : 's'}**.`,
                });
            }
            await sleep(1000);
            await channel.delete('Ticket closed by Owner or Representative');
        } catch (error) {
            console.error('Failed to close ticket:', error);
            closingTickets.delete(channel.id);
            if (!interaction.replied) {
                await interaction.editReply({ content: 'Unable to close this ticket.' }).catch(() => {});
            }
        }
        return;
    }

    const ticket = TICKET_TYPES.get(ticketType);
    if (!ticket) {
        return interaction.editReply({ content: 'Unknown ticket type.' });
    }

    try {
        const channels = await guild.channels.fetch();
        const category = channels.find(channel =>
            channel.type === ChannelType.GuildCategory &&
            channel.name === TICKET_CATEGORY_NAME
        );

        if (!category) {
            return interaction.editReply({
                content: `The ticket category "${TICKET_CATEGORY_NAME}" could not be found.`,
            });
        }

        const existingTicket = channels.find(channel =>
            channel.type === ChannelType.GuildText &&
            channel.parentId === category.id &&
            channel.topic === ticketTopic(ticketType, interaction.user.id)
        );
        if (existingTicket) {
            return interaction.editReply({
                content: `You already have an open **${ticket.label}** ticket: ${existingTicket}.`,
            });
        }

        const [ownerRole, representativeRole] = await Promise.all([
            guild.roles.fetch(OWNER_ROLE_ID).catch(() => null),
            guild.roles.fetch(REPRESENTATIVE_ROLE_ID).catch(() => null),
        ]);
        if (!ownerRole || !representativeRole) {
            return interaction.editReply({
                content: 'The configured Owner or Representative role could not be found in this server.',
            });
        }

        const ticketChannel = await guild.channels.create({
            name: ticketChannelName(ticketType, interaction.user.username),
            type: ChannelType.GuildText,
            parent: category.id,
            topic: ticketTopic(ticketType, interaction.user.id),
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: interaction.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks,
                    ],
                },
                {
                    id: ownerRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                },
                {
                    id: representativeRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageChannels,
                    ],
                },
            ],
        });

        const closeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ticket:close')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
        );
        await ticketChannel.send({
            content: `${interaction.user} <@&${ownerRole.id}> <@&${representativeRole.id}>`,
            allowedMentions: {
                users: [interaction.user.id],
                roles: [ownerRole.id, representativeRole.id],
            },
            embeds: [{
                title: `${ticket.label} Ticket`,
                description: ticket.description,
                color: 0x5865F2,
            }],
            components: [closeRow],
        });

        return interaction.editReply({ content: `Your ticket has been created: ${ticketChannel}` });
    } catch (error) {
        console.error('Failed to create ticket:', error);
        return interaction.editReply({ content: 'Unable to create your ticket right now. Please try again later.' });
    }
}

async function getOrCreateCashoutTicketChannel(guild, user) {
    const channels = await guild.channels.fetch();
    const category = channels.find(channel =>
        channel.type === ChannelType.GuildCategory &&
        channel.name === TICKET_CATEGORY_NAME
    );

    const targetTopic = `ticket:cashout:${user.id}`;
    const existingTicket = channels.find(channel =>
        channel.type === ChannelType.GuildText &&
        channel.topic === targetTopic
    );

    if (existingTicket) {
        return { channel: existingTicket, isNew: false };
    }

    const [ownerRole, representativeRole] = await Promise.all([
        guild.roles.fetch(OWNER_ROLE_ID).catch(() => null),
        guild.roles.fetch(REPRESENTATIVE_ROLE_ID).catch(() => null),
    ]);

    const safeUsername = user.username
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'user';

    const overwrites = [
        {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
        },
        {
            id: user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks,
            ],
        },
        {
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
            ],
        },
    ];

    if (ownerRole) {
        overwrites.push({
            id: ownerRole.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
            ],
        });
    }

    if (representativeRole) {
        overwrites.push({
            id: representativeRole.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
            ],
        });
    }

    const ticketChannel = await guild.channels.create({
        name: `cashout-${safeUsername}`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: category ? category.id : undefined,
        topic: targetTopic,
        permissionOverwrites: overwrites,
    });

    return { channel: ticketChannel, isNew: true, ownerRole, representativeRole };
}

async function handleCashoutButton(interaction) {
    if (!interaction.inGuild()) {
        return interaction.reply({ content: 'Cashout buttons can only be used inside a server.', flags: MessageFlags.Ephemeral });
    }

    const [, action, rawRequestId] = interaction.customId.split(':');
    const requestId = parseInt(rawRequestId, 10);

    if (action === 'approve') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const isStaff = hasSupportRole(interaction) || isAdmin(interaction);
        if (!isStaff) {
            return interaction.editReply({
                content: '❌ Unauthorized: Only server Admins, Owners, or Representatives can approve cashout requests.',
            });
        }

        const res = await approveCashoutRequest(db, {
            requestId,
            adminId: interaction.user.id,
        });

        if (!res.success) {
            return interaction.editReply({ content: `❌ ${res.error}` });
        }

        const updatedRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ticket:close')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Secondary)
        );

        if (interaction.message) {
            const updatedEmbed = {
                title: `💸 Cashout Request #${requestId} — Approved`,
                fields: [
                    { name: 'User', value: `<@${res.req.user_id}>`, inline: true },
                    { name: 'Amount Deducted', value: `**${fmt(res.deductedAmount)} tokens**`, inline: true },
                    { name: 'Remaining Balance', value: `${fmt(res.remainingBalance)} tokens`, inline: true },
                    { name: 'Status', value: `🟢 **Completed & Deducted**`, inline: true },
                    { name: 'Approved By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Completed At', value: `<t:${Math.floor(res.completedAt / 1000)}:F>`, inline: true },
                ],
                color: 0x57F287,
            };
            await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedRow] }).catch(() => {});
        }

        await interaction.channel?.send({
            content: `✅ **Cashout Approved & Completed**\n**${fmt(res.deductedAmount)} tokens** deducted from <@${res.req.user_id}> by <@${interaction.user.id}>.\nRemaining user balance: **${fmt(res.remainingBalance)} tokens**.`,
            allowedMentions: { users: [res.req.user_id] },
        }).catch(() => {});

        return interaction.editReply({ content: `✅ Cashout request #${requestId} successfully approved and completed.` });
    }

    if (action === 'reject') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const isStaff = hasSupportRole(interaction) || isAdmin(interaction);
        if (!isStaff) {
            return interaction.editReply({
                content: '❌ Unauthorized: Only server Admins, Owners, or Representatives can reject cashout requests.',
            });
        }

        const res = await rejectCashoutRequest(db, {
            requestId,
            adminId: interaction.user.id,
        });

        if (!res.success) {
            return interaction.editReply({ content: `❌ ${res.error}` });
        }

        const updatedRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ticket:close')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Secondary)
        );

        if (interaction.message) {
            const updatedEmbed = {
                title: `💸 Cashout Request #${requestId} — Rejected`,
                fields: [
                    { name: 'User', value: `<@${res.req.user_id}>`, inline: true },
                    { name: 'Requested Amount', value: `**${fmt(res.req.amount)} tokens**`, inline: true },
                    { name: 'Status', value: `🔴 **Rejected**`, inline: true },
                    { name: 'Rejected By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Note', value: 'User balance was NOT deducted.', inline: false },
                ],
                color: 0xED4245,
            };
            await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedRow] }).catch(() => {});
        }

        await interaction.channel?.send({
            content: `❌ **Cashout Request Rejected**\nCashout request #${requestId} for **${fmt(res.req.amount)} tokens** was rejected by <@${interaction.user.id}>. User balance was not deducted.`,
            allowedMentions: { users: [res.req.user_id] },
        }).catch(() => {});

        return interaction.editReply({ content: `❌ Cashout request #${requestId} rejected.` });
    }
}

async function handleCashoutModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawAmount = interaction.fields.getTextInputValue('cashout_amount')?.trim();
    const amount = parseFloat(rawAmount);

    if (isNaN(amount) || amount <= 0) {
        return interaction.editReply({ content: '❌ Please enter a valid positive number of tokens.' });
    }

    if (amount > MAX_CASHOUT_AMOUNT) {
        return interaction.editReply({ content: `❌ Maximum cashout limit is **${MAX_CASHOUT_AMOUNT.toLocaleString()} tokens** per request.` });
    }

    const user = await getOrCreateUser(interaction.user.id);
    if (user.wallet_tokens < amount) {
        return interaction.editReply({
            content: `❌ Insufficient balance. You requested **${fmt(amount)} tokens**, but your available balance is only **${fmt(user.wallet_tokens)} tokens**.`,
        });
    }

    const res = await createCashoutRequest(db, {
        userId: interaction.user.id,
        amount,
        channelId: interaction.channelId,
    });

    if (!res.success) {
        return interaction.editReply({ content: `❌ ${res.error}` });
    }

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cashout:approve:${res.requestId}`)
            .setLabel('Approve & Complete')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`cashout:reject:${res.requestId}`)
            .setLabel('Reject Cashout')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('ticket:close')
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.channel?.send({
        content: `${interaction.user} <@&${OWNER_ROLE_ID}> <@&${REPRESENTATIVE_ROLE_ID}>`,
        allowedMentions: {
            users: [interaction.user.id],
            roles: [OWNER_ROLE_ID, REPRESENTATIVE_ROLE_ID],
        },
        embeds: [{
            title: `💸 Cashout Request #${res.requestId}`,
            description: `A new cashout request has been submitted for review.`,
            fields: [
                { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
                { name: 'Requested Amount', value: `**${fmt(amount)} tokens**`, inline: true },
                { name: 'Available Balance', value: `${fmt(user.wallet_tokens)} tokens`, inline: true },
                { name: 'Status', value: '🟡 **Pending Admin Review**', inline: true },
                { name: 'Submission Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                { name: 'Note', value: 'Tokens remain in user wallet until an admin marks this request as completed.', inline: false },
            ],
            color: 0xFEE75C,
        }],
        components: [actionRow],
    }).catch(() => {});

    return interaction.editReply({ content: `✅ Cashout request #${res.requestId} for **${fmt(amount)} tokens** submitted for admin review.` });
}

async function generateBackup() {
    const users = await db.prepare('SELECT * FROM users').all();
    const companies = await db.prepare('SELECT * FROM companies').all();
    const priceHistory = await db.prepare('SELECT * FROM price_history ORDER BY timestamp ASC').all();
    const sellOrders = await db.prepare('SELECT * FROM sell_orders').all();
    const tradeLedger = await db.prepare('SELECT * FROM trade_ledger ORDER BY timestamp ASC, id ASC').all();
    const laxAccount = await db.prepare('SELECT * FROM lax_account').all();
    const laxTreasury = await db.prepare('SELECT * FROM lax_treasury').all();
    const laxTreasuryLots = await db.prepare('SELECT * FROM lax_treasury_lots').all();
    const laxTransactions = await db.prepare('SELECT * FROM lax_transactions ORDER BY timestamp ASC, id ASC').all();
    const userCooldowns = await db.prepare('SELECT * FROM user_cooldowns').all();

    const payload = {
        v: 2,
        ts: Date.now(),
        users,
        companies,
        priceHistory,
        sellOrders,
        tradeLedger,
        laxAccount,
        laxTreasury,
        laxTreasuryLots,
        laxTransactions,
        userCooldowns,
    };
    const compressed = await deflate(Buffer.from(JSON.stringify(payload)));
    return compressed.toString('base64');
}

async function restoreBackup(code) {
    const json = (await inflate(Buffer.from(code.trim(), 'base64'))).toString();
    const data = JSON.parse(json);
    if (!data.v || !data.users || !data.companies) throw new Error('Invalid backup format.');

    await db.transaction(async tx => {
        await tx.prepare('DELETE FROM sell_orders').run();
        await tx.prepare('DELETE FROM trade_ledger').run();
        await tx.prepare('DELETE FROM price_history').run();
        await tx.prepare('DELETE FROM companies').run();
        await tx.prepare('DELETE FROM users').run();

        for (const u of data.users)
            await tx.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, ?, ?)').run(u.discord_id, u.wallet_tokens, u.portfolio);

        for (const c of data.companies)
            await tx.prepare(`INSERT INTO companies
                (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve, pending_cashout_tokens, all_time_earnings, emoji)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(c.ticker, c.company_name, c.owner_id, c.ipo_share_price, c.current_price, c.total_supply, c.shares_in_circulation, c.bot_share_reserve, c.pending_cashout_tokens, c.all_time_earnings, c.emoji ?? '🏢');

        for (const h of data.priceHistory)
            await tx.prepare('INSERT INTO price_history (id, ticker, price, timestamp) VALUES (?, ?, ?, ?)').run(h.id, h.ticker, h.price, h.timestamp);

        for (const s of data.sellOrders)
            await tx.prepare('INSERT INTO sell_orders (id, seller_id, ticker, shares, list_price, timestamp) VALUES (?, ?, ?, ?, ?, ?)').run(s.id, s.seller_id, s.ticker, s.shares, s.list_price, s.timestamp);

        for (const t of data.tradeLedger ?? [])
            await tx.prepare('INSERT INTO trade_ledger (id, ticker, buyer_id, seller_id, shares, trade_value, fee_amount, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(t.id, t.ticker, t.buyer_id, t.seller_id, t.shares, t.trade_value, t.fee_amount, t.timestamp);

        if (data.laxAccount?.length) {
            await tx.prepare('DELETE FROM lax_account').run();
            for (const a of data.laxAccount) {
                await tx.prepare('INSERT INTO lax_account (id, balance, debt_floor, kill_switch_enabled, realized_pnl, total_withdrawn) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(a.id, a.balance, a.debt_floor, a.kill_switch_enabled, a.realized_pnl, a.total_withdrawn);
            }
        }

        if (data.laxTreasury?.length) {
            await tx.prepare('DELETE FROM lax_treasury').run();
            for (const tr of data.laxTreasury) {
                await tx.prepare('INSERT INTO lax_treasury (ticker, shares, total_acquisition_cost, updated_at) VALUES (?, ?, ?, ?)')
                    .run(tr.ticker, tr.shares, tr.total_acquisition_cost, tr.updated_at);
            }
        }

        if (data.laxTreasuryLots?.length) {
            await tx.prepare('DELETE FROM lax_treasury_lots').run();
            for (const l of data.laxTreasuryLots) {
                await tx.prepare('INSERT INTO lax_treasury_lots (id, ticker, shares, original_shares, unit_cost, total_cost, timestamp, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(l.id, l.ticker, l.shares, l.original_shares, l.unit_cost, l.total_cost, l.timestamp, l.status);
            }
        }

        if (data.laxTransactions?.length) {
            await tx.prepare('DELETE FROM lax_transactions').run();
            for (const x of data.laxTransactions) {
                await tx.prepare('INSERT INTO lax_transactions (id, transaction_id, transaction_type, user_id, ticker, shares, price_per_share, total_value, acquisition_cost, realized_pnl, resulting_lax_balance, resulting_treasury_shares, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(x.id, x.transaction_id, x.transaction_type, x.user_id, x.ticker, x.shares, x.price_per_share, x.total_value, x.acquisition_cost, x.realized_pnl, x.resulting_lax_balance, x.resulting_treasury_shares, x.timestamp);
            }
        }

        if (data.userCooldowns?.length) {
            await tx.prepare('DELETE FROM user_cooldowns').run();
            for (const c of data.userCooldowns) {
                await tx.prepare('INSERT INTO user_cooldowns (user_id, action, last_used_at) VALUES (?, ?, ?)')
                    .run(c.user_id, c.action, c.last_used_at);
            }
        }
    });

    return data;
}

function generateChartUrl(prices, timestamps, companyName) {
    const labels = timestamps.map(timestamp => {
        const date = new Date(timestamp);
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    });
    const priceChange = prices[prices.length - 1] - prices[0];
    const lineColor = priceChange >= 0 ? '#00ff88' : '#ff4444';
    const chartConfig = {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: companyName,
                data: prices,
                borderColor: lineColor,
                backgroundColor: priceChange >= 0 ? 'rgba(0, 255, 136, 0.18)' : 'rgba(255, 68, 68, 0.18)',
                fill: true,
                tension: 0.25,
                pointRadius: 2,
                pointBackgroundColor: lineColor,
            }],
        },
        options: {
            plugins: {
                legend: { labels: { color: '#e6edf3' } },
                title: {
                    display: true,
                    text: companyName,
                    color: '#e6edf3',
                    font: { size: 20 },
                },
            },
            scales: {
                x: {
                    ticks: { color: '#8b949e', maxTicksLimit: 6 },
                    grid: { color: '#21262d' },
                },
                y: {
                    ticks: { color: '#8b949e' },
                    grid: { color: '#21262d' },
                },
            },
        },
    };

    return `https://quickchart.io/chart?width=800&height=400&backgroundColor=%230d1117&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
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
    await db.ready;
    const userCount = (await db.prepare('SELECT COUNT(*) as n FROM users').get())?.n ?? 0;
    const companyCount = (await db.prepare('SELECT COUNT(*) as n FROM companies').get())?.n ?? 0;

    console.log('Bot is online!');
    console.log(`Bot is currently in ${client.guilds.cache.size} server(s).`);
    console.log(`[Database Status] Mode: ${db.isRemote ? 'Remote Turso Cloud' : 'Local SQLite (data.db)'} | Companies: ${companyCount} | Registered Users: ${userCount}`);
    if (!db.isRemote) {
        console.warn('⚠️ [Database Notice] Bot is currently running on Local SQLite storage because TURSO_DATABASE_URL is not set in your server environment. If your data is in Turso, please configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your .env or host settings.');
    }
    await registerCommands(process.env.GUILD_ID, client);

    const backupChannelId = process.env.BACKUP_CHANNEL_ID;
    if (backupChannelId) {
        try {
            const channel = await client.channels.fetch(backupChannelId);
            if (channel) {
                const code = await generateBackup();
                const buf = Buffer.from(code, 'utf-8');
                const file = new AttachmentBuilder(buf, { name: `economy-backup-${Date.now()}.txt` });
                await channel.send({
                    embeds: [{
                        title: '🔄 Auto Backup — Bot Started',
                        description: `Snapshot taken on startup. Use \`/economy-restore\` and upload this file to restore.`,
                        fields: [
                            { name: 'Database Mode', value: db.isRemote ? 'Turso Cloud' : 'Local SQLite', inline: true },
                            { name: 'Users', value: `${userCount}`, inline: true },
                            { name: 'Companies', value: `${companyCount}`, inline: true },
                            { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        ],
                        color: 0x5865F2,
                    }],
                    files: [file],
                });
            }
        } catch (err) {
            console.error('Auto-backup failed:', err.message);
        }
    }
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.customId === 'cashout:open_modal') {
            const modal = new ModalBuilder()
                .setCustomId('cashout:submit_modal')
                .setTitle('Request Cashout');

            const amountInput = new TextInputBuilder()
                .setCustomId('cashout_amount')
                .setLabel('Amount to Cash Out (Max: 8,000)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g. 500')
                .setRequired(true);

            const row = new ActionRowBuilder().addComponents(amountInput);
            modal.addComponents(row);
            return interaction.showModal(modal);
        }

        if (interaction.customId.startsWith('cashout:')) {
            await handleCashoutButton(interaction);
            return;
        }

        if (interaction.customId.startsWith('ticket:')) {
            await handleTicketButton(interaction);
            return;
        }

        if (interaction.customId.startsWith('sell:')) {
            const parts = interaction.customId.split(':');
            const action = parts[1];
            const targetUserId = parts[2];

            if (interaction.user.id !== targetUserId) {
                return interaction.reply({
                    content: '❌ Only the user who ran the /sell command can interact with these confirmation buttons.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (action === 'cancel') {
                return interaction.update({
                    content: '❌ Instant sell transaction cancelled. No shares or cooldowns were consumed.',
                    embeds: [],
                    components: [],
                });
            }

            if (action === 'confirm') {
                const ticker = parts[3];
                const amount = parseInt(parts[4], 10);

                await interaction.deferUpdate();

                const result = await treasury.executeInstantSell(db, {
                    userId: interaction.user.id,
                    ticker,
                    shares: amount,
                });

                if (!result.success) {
                    return interaction.editReply({
                        content: `❌ ${result.error}`,
                        embeds: [],
                        components: [],
                    });
                }

                return interaction.editReply({
                    content: null,
                    embeds: [{
                        title: `⚡ Instant Sell Completed — ${result.ticker}`,
                        description: `Successfully sold **${result.sharesSold.toLocaleString()}** shares directly to LAX Treasury.`,
                        fields: [
                            { name: 'Company', value: `**${result.companyName}** (\`${result.ticker}\`)`, inline: true },
                            { name: 'Shares Sold', value: `${result.sharesSold.toLocaleString()}`, inline: true },
                            { name: 'Buyback Price', value: `${fmt(result.buybackPrice)} tokens/share`, inline: true },
                            { name: 'Tokens Received', value: `**+${fmt(result.totalTokensReceived)} tokens**`, inline: true },
                            { name: 'New Wallet Balance', value: `${fmt(result.newUserBalance)} tokens`, inline: true },
                            { name: 'New Market Price', value: `${fmt(result.newMarketPrice)} tokens`, inline: true },
                            { name: 'Transaction ID', value: `\`${result.txId}\``, inline: true },
                            { name: 'Next Instant Sell Available', value: `<t:${Math.floor(result.cooldownExpiresAt / 1000)}:R>`, inline: true },
                        ],
                        color: 0x57F287,
                    }],
                    components: [],
                });
            }
            return;
        }
        return;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'cashout:submit_modal') {
            await handleCashoutModal(interaction);
            return;
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.replied || interaction.deferred) return;

    const { commandName } = interaction;

    try {
        await interaction.deferReply();
    } catch (deferError) {
        if (deferError.code === 10062 || deferError.code === 40060) {
            console.warn(`[InteractionLifecycle] Interaction for /${commandName} expired or was already handled by another process (Discord code ${deferError.code}).`);
            return;
        }
        console.error(`[InteractionLifecycle] Failed to defer /${commandName}:`, deferError);
        return;
    }

    try {
        // ── /balance ──────────────────────────────────────────────────────────
        if (commandName === 'balance') {
            const user = await getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(user);
            const entries = Object.entries(portfolio);

            let portfolioText = entries.length === 0
                ? 'No stocks owned.'
                : entries.map(([t, s]) => `**${t}**: ${s} share${s !== 1 ? 's' : ''}`).join('\n');

            return interaction.editReply({
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
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const target = interaction.options.getUser('user');
            const amount = interaction.options.getNumber('amount');
            await getOrCreateUser(target.id);
            await db.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?').run(amount, target.id);

            return interaction.editReply({
                embeds: [{
                    title: '✅ Tokens Added',
                    description: `Added **${fmt(amount)} tokens** to **${target.username}**.`,
                    color: 0x57F287,
                }]
            });
        }

        // ── /admin-remove-money ───────────────────────────────────────────────
        if (commandName === 'admin-remove-money') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const target = interaction.options.getUser('user');
            const amount = interaction.options.getNumber('amount');
            await getOrCreateUser(target.id);
            await db.prepare('UPDATE users SET wallet_tokens = MAX(0, wallet_tokens - ?) WHERE discord_id = ?').run(amount, target.id);

            return interaction.editReply({
                embeds: [{
                    title: '✅ Tokens Removed',
                    description: `Removed **${fmt(amount)} tokens** from **${target.username}**.`,
                    color: 0xED4245,
                }]
            });
        }

        // ── /leaderboard ──────────────────────────────────────────────────────
        if (commandName === 'leaderboard') {
            const top = await db.prepare('SELECT discord_id, wallet_tokens FROM users ORDER BY wallet_tokens DESC LIMIT 10').all();

            if (top.length === 0) return interaction.editReply({ content: 'No users found.', flags: MessageFlags.Ephemeral });

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

            return interaction.editReply({
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

            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });

            const buyer = await getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(buyer);

            const sellOrders = await db.prepare(
                'SELECT * FROM sell_orders WHERE ticker = ? AND seller_id != ? ORDER BY list_price ASC, timestamp ASC'
            ).all(ticker, interaction.user.id);

            const treasuryItem = await db.prepare('SELECT * FROM lax_treasury WHERE ticker = ?').get(ticker);
            const availableTreasuryShares = treasuryItem ? treasuryItem.shares : 0;

            let remaining = amount;
            let totalCost = 0;
            const ordersToFill = [];
            let sharesFromTreasury = 0;
            let sharesFromBot = 0;

            for (const order of sellOrders) {
                if (remaining <= 0) break;
                const fill = Math.min(order.shares, remaining);
                totalCost += fill * order.list_price;
                ordersToFill.push({ order, fill });
                remaining -= fill;
            }

            if (remaining > 0 && availableTreasuryShares > 0) {
                sharesFromTreasury = Math.min(remaining, availableTreasuryShares);
                totalCost += sharesFromTreasury * company.current_price;
                remaining -= sharesFromTreasury;
            }

            if (remaining > 0) {
                if (company.bot_share_reserve < remaining)
                    return interaction.editReply({
                        content: `Not enough shares available. Bot reserve: **${company.bot_share_reserve}**, Treasury: **${availableTreasuryShares}**, sell orders available: **${amount - remaining - sharesFromTreasury}**.`,
                        flags: MessageFlags.Ephemeral,
                    });
                totalCost += remaining * company.current_price;
                sharesFromBot = remaining;
            }

            if (buyer.wallet_tokens < totalCost)
                    return interaction.editReply({ content: `Insufficient tokens. Need **${fmt(totalCost)}**, you have **${fmt(buyer.wallet_tokens)}**.`, flags: MessageFlags.Ephemeral });

            let newPrice = company.current_price;
            let totalFees = 0;
            let completedTrades = 0;
            const tradeTimestamp = Date.now();

            await db.transaction(async tx => {
                await tx.prepare('INSERT OR IGNORE INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, 0, ?)')
                    .run(EXCHANGE_OWNER_ID, '{}');

                // Complete trades against user sell orders. The buyer pays the gross
                // trade value; the seller receives the value less the exchange fee.
                for (const { order, fill } of ordersToFill) {
                    const tradeValue = Number((fill * order.list_price).toFixed(8));
                    const feeAmount = calculateExchangeFee(tradeValue);
                    const sellerPayout = tradeValue - feeAmount;
                    totalFees += feeAmount;
                    completedTrades += 1;

                    await tx.prepare('INSERT OR IGNORE INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, 0, ?)')
                        .run(order.seller_id, '{}');
                    await tx.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?')
                        .run(sellerPayout, order.seller_id);

                    if (fill === order.shares) {
                        await tx.prepare('DELETE FROM sell_orders WHERE id = ?').run(order.id);
                    } else {
                        await tx.prepare('UPDATE sell_orders SET shares = shares - ? WHERE id = ?').run(fill, order.id);
                    }

                    await tx.prepare(`INSERT INTO trade_ledger
                        (ticker, buyer_id, seller_id, shares, trade_value, fee_amount, timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`
                    ).run(ticker, interaction.user.id, order.seller_id, fill, tradeValue, feeAmount, tradeTimestamp);
                }

                // Complete trades from LAX Treasury inventory
                if (sharesFromTreasury > 0) {
                    const trRes = await treasury.fulfillFromTreasury(tx, {
                        ticker,
                        requestedShares: sharesFromTreasury,
                        currentPrice: company.current_price,
                        tradeTimestamp,
                        buyerId: interaction.user.id,
                    });
                    totalFees += trRes.feeAmount;
                    completedTrades += 1;
                }

                // Complete any remaining shares against the bot reserve. The company
                // owner receives the net value, while the exchange owner receives the fee.
                if (sharesFromBot > 0) {
                    const botTradeValue = Number((sharesFromBot * company.current_price).toFixed(8));
                    const feeAmount = calculateExchangeFee(botTradeValue);
                    const ownerEarnings = botTradeValue - feeAmount;
                    totalFees += feeAmount;
                    completedTrades += 1;

                    await tx.prepare(`UPDATE companies SET
                        bot_share_reserve = bot_share_reserve - ?,
                        shares_in_circulation = shares_in_circulation + ?,
                        pending_cashout_tokens = pending_cashout_tokens + ?,
                        all_time_earnings = all_time_earnings + ?
                        WHERE ticker = ?`
                    ).run(sharesFromBot, sharesFromBot, ownerEarnings, ownerEarnings, ticker);
                    await tx.prepare('INSERT OR IGNORE INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, 0, ?)')
                        .run(company.owner_id, '{}');
                    await tx.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?')
                        .run(ownerEarnings, company.owner_id);
                    await tx.prepare(`INSERT INTO trade_ledger
                        (ticker, buyer_id, seller_id, shares, trade_value, fee_amount, timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`
                    ).run(ticker, interaction.user.id, company.owner_id, sharesFromBot, botTradeValue, feeAmount, tradeTimestamp);
                }

                // Adjust price up for all shares bought from Treasury & Bot reserve
                const totalMarketShares = sharesFromTreasury + sharesFromBot;
                if (totalMarketShares > 0) {
                    newPrice = adjustPrice(company.current_price, totalMarketShares, 'up');
                    await tx.prepare('UPDATE companies SET current_price = ? WHERE ticker = ?').run(newPrice, ticker);
                    await tx.prepare('INSERT INTO price_history (ticker, price, timestamp) VALUES (?, ?, ?)')
                        .run(ticker, newPrice, tradeTimestamp);
                }

                await tx.prepare('UPDATE users SET wallet_tokens = wallet_tokens + ? WHERE discord_id = ?')
                    .run(totalFees, EXCHANGE_OWNER_ID);

                // Deduct the gross trade value from the buyer and update the portfolio.
                portfolio[ticker] = (portfolio[ticker] || 0) + amount;
                await tx.prepare('UPDATE users SET wallet_tokens = wallet_tokens - ?, portfolio = ? WHERE discord_id = ?')
                    .run(totalCost, JSON.stringify(portfolio), interaction.user.id);
            });

            console.log(`Completed ${completedTrades} ${ticker} trade(s); exchange fee: ${fmt(totalFees)} tokens.`);

            if (interaction.guild) {
                await ensureInvestorRole(interaction.guild, interaction.user.id);
            }

            const sharesFromOrders = amount - sharesFromTreasury - sharesFromBot;
            return interaction.editReply({
                embeds: [{
                    title: `📈 Bought ${amount} shares of ${ticker}`,
                    fields: [
                        { name: 'Trade Value', value: `${fmt(totalCost)} tokens`, inline: true },
                        { name: 'Exchange Fee (1%)', value: `${fmt(totalFees)} tokens`, inline: true },
                        { name: 'New Price', value: `${fmt(newPrice)} tokens`, inline: true },
                        { name: 'From Sellers', value: `${sharesFromOrders} shares`, inline: true },
                        { name: 'From Treasury', value: `${sharesFromTreasury} shares`, inline: true },
                        { name: 'From Bot Reserve', value: `${sharesFromBot} shares`, inline: true },
                        { name: 'Completed Trades', value: `${completedTrades}`, inline: true },
                    ],
                    color: 0x57F287,
                }]
            });
        }

        // ── /stock-sell ───────────────────────────────────────────────────────
        if (commandName === 'stock-sell') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const amount = interaction.options.getInteger('amount');

            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });

            const user = await getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(user);
            const owned = portfolio[ticker] || 0;

            if (owned < amount)
                return interaction.editReply({ content: `You only own **${owned}** shares of **${ticker}**.`, flags: MessageFlags.Ephemeral });

            // Remove from portfolio
            portfolio[ticker] = owned - amount;
            if (portfolio[ticker] === 0) delete portfolio[ticker];
            await db.prepare('UPDATE users SET portfolio = ? WHERE discord_id = ?').run(JSON.stringify(portfolio), interaction.user.id);

            // Create sell order at current price
            const listPrice = company.current_price;
            await db.prepare('INSERT INTO sell_orders (seller_id, ticker, shares, list_price, timestamp) VALUES (?, ?, ?, ?, ?)')
                .run(interaction.user.id, ticker, amount, listPrice, Date.now());

            // Price goes down
            const newPrice = adjustPrice(company.current_price, amount, 'down');
            await db.prepare('UPDATE companies SET current_price = ? WHERE ticker = ?').run(newPrice, ticker);
            await recordPrice(ticker, newPrice);

            return interaction.editReply({
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

            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });

            const orders = await db.prepare(
                'SELECT * FROM sell_orders WHERE seller_id = ? AND ticker = ? ORDER BY timestamp ASC'
            ).all(interaction.user.id, ticker);

            if (orders.length === 0)
                return interaction.editReply({ content: `You have no active sell listings for **${ticker}**.`, flags: MessageFlags.Ephemeral });

            const totalListed = orders.reduce((s, o) => s + o.shares, 0);
            const toCancel = cancelAmount !== null ? Math.min(cancelAmount, totalListed) : totalListed;

            if (toCancel <= 0)
                return interaction.editReply({ content: `Nothing to cancel.`, flags: MessageFlags.Ephemeral });

            // Remove orders oldest-first up to toCancel shares
            let remaining = toCancel;
            for (const order of orders) {
                if (remaining <= 0) break;
                if (order.shares <= remaining) {
                    await db.prepare('DELETE FROM sell_orders WHERE id = ?').run(order.id);
                    remaining -= order.shares;
                } else {
                    await db.prepare('UPDATE sell_orders SET shares = shares - ? WHERE id = ?').run(remaining, order.id);
                    remaining = 0;
                }
            }

            // Return shares to portfolio
            const user = await getOrCreateUser(interaction.user.id);
            const portfolio = getPortfolio(user);
            portfolio[ticker] = (portfolio[ticker] || 0) + toCancel;
            await db.prepare('UPDATE users SET portfolio = ? WHERE discord_id = ?').run(JSON.stringify(portfolio), interaction.user.id);

            // Price goes back up (reverse of listing)
            const newPrice = adjustPrice(company.current_price, toCancel, 'up');
            await db.prepare('UPDATE companies SET current_price = ? WHERE ticker = ?').run(newPrice, ticker);
            await recordPrice(ticker, newPrice);

            const stillListed = totalListed - toCancel;
            return interaction.editReply({
                embeds: [{
                    title: `✅ Cancelled ${toCancel} sell listing${toCancel !== 1 ? 's' : ''} for ${ticker}`,
                    fields: [
                        { name: 'Shares Returned', value: `${toCancel}`, inline: true },
                        { name: 'Still Listed', value: `${stillListed}`, inline: true },
                        { name: 'New Market Price', value: `${fmt(newPrice)} tokens`, inline: true },
                    ],
                    color: 0x57F287,
                }],
                flags: MessageFlags.Ephemeral,
            });
        }

        // ── /stock-info ───────────────────────────────────────────────────────
        if (commandName === 'stock-info') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });

            const marketCap = company.current_price * company.shares_in_circulation;
            const sellOrderCount = await db.prepare('SELECT COUNT(*) as cnt, SUM(shares) as total FROM sell_orders WHERE ticker = ?').get(ticker);
            const emoji = company.emoji ?? '🏢';

            const history = await db.prepare('SELECT price, timestamp FROM price_history WHERE ticker = ? ORDER BY timestamp DESC LIMIT 60').all(ticker);
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
                return interaction.editReply({ embeds: [embedData] });
            }

            embedData.image = { url: generateChartUrl(prices, timestamps, company.company_name) };

            return interaction.editReply({ embeds: [embedData] });
        }

        // ── /stock-list ───────────────────────────────────────────────────────
        if (commandName === 'stock-list') {
            const companies = await db.prepare('SELECT * FROM companies ORDER BY current_price DESC').all();
            if (companies.length === 0) return interaction.editReply({ content: 'No companies listed yet.', flags: MessageFlags.Ephemeral });

            const lines = companies.map(c => {
                const change = ((c.current_price - c.ipo_share_price) / c.ipo_share_price * 100).toFixed(1);
                const arrow = c.current_price >= c.ipo_share_price ? '📈' : '📉';
                return `${arrow} **${c.ticker}** — ${c.company_name}\n  Price: **${fmt(c.current_price)}** tokens (${change}% from IPO) | Reserve: ${c.bot_share_reserve}`;
            });

            return interaction.editReply({
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
            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });

            const history = await db.prepare('SELECT price, timestamp FROM price_history WHERE ticker = ? ORDER BY timestamp DESC LIMIT 60').all(ticker);

            if (history.length < 2)
                return interaction.editReply({ content: `Not enough price history for **${ticker}** yet. Buy or sell some shares first!`, flags: MessageFlags.Ephemeral });

            history.reverse();
            const prices = history.map(h => h.price);
            const timestamps = history.map(h => h.timestamp);

            const priceChange = prices[prices.length - 1] - prices[0];
            const pct = ((priceChange / prices[0]) * 100).toFixed(2);
            const emoji = company.emoji ?? '🏢';
            const chartUrl = generateChartUrl(prices, timestamps, company.company_name);

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
                    image: { url: chartUrl },
                    color: priceChange >= 0 ? 0x57F287 : 0xED4245,
                }],
            });
        }

        // ── /admin-removecompany ──────────────────────────────────────────────
        if (commandName === 'admin-removecompany') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const confirm = interaction.options.getString('confirm') ?? 'yes';

            if (confirm === 'no')
                return interaction.editReply({ content: `❌ Removal of **${ticker}** cancelled.`, flags: MessageFlags.Ephemeral });

            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });

            await db.prepare('DELETE FROM companies WHERE ticker = ?').run(ticker);
            await db.prepare('DELETE FROM price_history WHERE ticker = ?').run(ticker);
            await db.prepare('DELETE FROM sell_orders WHERE ticker = ?').run(ticker);

            return interaction.editReply({
                embeds: [{
                    title: '🗑️ Company Removed',
                    description: `**${company.company_name} (${ticker})** has been deleted along with its price history and open sell orders.`,
                    color: 0xED4245,
                }]
            });
        }

        // ── /admin-editcompany ────────────────────────────────────────────────
        if (commandName === 'admin-editcompany') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });

            const newName   = interaction.options.getString('name')   ?? company.company_name;
            const newOwner  = interaction.options.getUser('owner');
            const newPrice  = interaction.options.getNumber('price')  ?? company.current_price;
            const newEmoji  = interaction.options.getString('emoji')  ?? company.emoji ?? '🏢';
            const newSupply = interaction.options.getInteger('supply');
            const ownerId   = newOwner ? newOwner.id : company.owner_id;

            let updatedTotalSupply = company.total_supply;
            let updatedBotReserve  = company.bot_share_reserve;

            if (newSupply !== null && newSupply !== undefined) {
                if (newSupply < company.shares_in_circulation) {
                    return interaction.editReply({
                        content: `❌ Cannot set total supply to **${newSupply.toLocaleString()}**. There are already **${company.shares_in_circulation.toLocaleString()}** shares in circulation. Total supply must be at least **${company.shares_in_circulation.toLocaleString()}**.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
                updatedTotalSupply = newSupply;
                updatedBotReserve = newSupply - company.shares_in_circulation;
            }

            await db.prepare(`UPDATE companies SET company_name = ?, owner_id = ?, current_price = ?, emoji = ?, total_supply = ?, bot_share_reserve = ? WHERE ticker = ?`)
                .run(newName, ownerId, newPrice, newEmoji, updatedTotalSupply, updatedBotReserve, ticker);

            if (newPrice !== company.current_price) await recordPrice(ticker, newPrice);

            const changes = [];
            if (newName !== company.company_name)   changes.push(`Name → **${newName}**`);
            if (ownerId !== company.owner_id)        changes.push(`Owner → **${newOwner.username}**`);
            if (newPrice !== company.current_price) changes.push(`Price → **${fmt(newPrice)}** tokens`);
            if (newSupply !== null && newSupply !== undefined && newSupply !== company.total_supply) {
                changes.push(`Total Supply → **${updatedTotalSupply.toLocaleString()}** (Reserve: **${updatedBotReserve.toLocaleString()}**)`);
            }
            if (newEmoji !== (company.emoji ?? '🏢')) changes.push(`Emoji → ${newEmoji}`);

            return interaction.editReply({
                embeds: [{
                    title: `${newEmoji} ${newName} (${ticker}) Updated`,
                    description: changes.length ? changes.join('\n') : 'No changes made.',
                    color: 0x5865F2,
                }]
            });
        }

        // ── /provide-shares ───────────────────────────────────────────────────
        if (commandName === 'provide-shares') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const targetUser = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');

            if (amount <= 0) {
                return interaction.editReply({ content: 'Amount must be greater than 0.', flags: MessageFlags.Ephemeral });
            }

            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) {
                return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });
            }

            // Validate that the company has enough unallocated reserve shares
            if (company.bot_share_reserve < amount) {
                return interaction.editReply({
                    content: `Insufficient unallocated shares. **${ticker}** has **${company.bot_share_reserve.toLocaleString()}** unallocated shares in reserve, but you requested **${amount.toLocaleString()}**.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const recipient = await getOrCreateUser(targetUser.id);
            const portfolio = getPortfolio(recipient);
            const tradeTimestamp = Date.now();

            // Execute atomic transfer:
            // 1. Deduct from bot_share_reserve and add to shares_in_circulation (total_supply & current_price untouched)
            // 2. Add shares to recipient user portfolio
            // 3. Log transaction in trade_ledger
            await db.transaction(async tx => {
                await tx.prepare(`UPDATE companies SET
                    bot_share_reserve = bot_share_reserve - ?,
                    shares_in_circulation = shares_in_circulation + ?
                    WHERE ticker = ?`
                ).run(amount, amount, ticker);

                portfolio[ticker] = (portfolio[ticker] || 0) + amount;
                await tx.prepare('UPDATE users SET portfolio = ? WHERE discord_id = ?')
                    .run(JSON.stringify(portfolio), targetUser.id);

                await tx.prepare(`INSERT INTO trade_ledger
                    (ticker, buyer_id, seller_id, shares, trade_value, fee_amount, timestamp)
                    VALUES (?, ?, ?, ?, 0, 0, ?)`
                ).run(ticker, targetUser.id, company.owner_id, amount, tradeTimestamp);
            });

            const remainingReserve = company.bot_share_reserve - amount;
            const newCirculation = company.shares_in_circulation + amount;
            const emoji = company.emoji ?? '🏢';

            if (interaction.guild) {
                await ensureInvestorRole(interaction.guild, targetUser.id);
            }

            return interaction.editReply({
                embeds: [{
                    title: `📦 ${emoji} Shares Provided: ${company.company_name} (${ticker})`,
                    description: `Successfully transferred **${amount.toLocaleString()}** unallocated shares to <@${targetUser.id}>.`,
                    fields: [
                        { name: 'Recipient', value: `<@${targetUser.id}> (${targetUser.username})`, inline: true },
                        { name: 'Shares Provided', value: `${amount.toLocaleString()}`, inline: true },
                        { name: 'Remaining Unallocated', value: `${remainingReserve.toLocaleString()}`, inline: true },
                        { name: 'In Circulation', value: `${newCirculation.toLocaleString()}`, inline: true },
                        { name: 'Total Supply', value: `${company.total_supply.toLocaleString()}`, inline: true },
                        { name: 'Current Share Price', value: `${fmt(company.current_price)} tokens`, inline: true },
                    ],
                    color: 0x57F287,
                }]
            });
        }

        // ── /history ─────────────────────────────────────────────────────────
        if (commandName === 'history') {
            const requestedTicker = interaction.options.getString('ticker')?.toUpperCase();
            const limit = interaction.options.getInteger('limit') || 10;
            const userId = interaction.user.id;

            let tradesQuery;
            let params;
            if (requestedTicker) {
                tradesQuery = `SELECT * FROM trade_ledger 
                               WHERE (buyer_id = ? OR seller_id = ?) AND ticker = ? 
                               ORDER BY timestamp DESC LIMIT ?`;
                params = [userId, userId, requestedTicker, limit];
            } else {
                tradesQuery = `SELECT * FROM trade_ledger 
                               WHERE (buyer_id = ? OR seller_id = ?) 
                               ORDER BY timestamp DESC LIMIT ?`;
                params = [userId, userId, limit];
            }

            const [trades, activeOrders, userRecord] = await Promise.all([
                db.prepare(tradesQuery).all(...params),
                db.prepare('SELECT * FROM sell_orders WHERE seller_id = ? ORDER BY timestamp DESC LIMIT 5').all(userId),
                getOrCreateUser(userId),
            ]);

            const portfolio = getPortfolio(userRecord);

            if (trades.length === 0 && activeOrders.length === 0) {
                return interaction.editReply({
                    embeds: [{
                        title: `📜 Transaction History: ${interaction.user.username}`,
                        description: requestedTicker 
                            ? `No recorded transactions found for **${requestedTicker}**.` 
                            : 'No recorded stock transactions found for your account yet.',
                        color: 0x5865F2,
                    }],
                });
            }

            const historyLines = trades.map(t => {
                const dateStr = `<t:${Math.floor(t.timestamp / 1000)}:d> <t:${Math.floor(t.timestamp / 1000)}:t>`;
                const relativeTime = `<t:${Math.floor(t.timestamp / 1000)}:R>`;
                const isBuyer = t.buyer_id === userId;
                const isSeller = t.seller_id === userId;

                if (isBuyer && !isSeller) {
                    const costStr = t.trade_value > 0 ? `${fmt(t.trade_value)} tokens` : 'Provided (0 tokens)';
                    const feeStr = t.fee_amount > 0 ? ` (fee: ${fmt(t.fee_amount)})` : '';
                    return `🟢 **BUY / RECEIVED** • \`${t.ticker}\`\n` +
                           `└ **+${t.shares.toLocaleString()}** shares for **${costStr}**${feeStr} — ${relativeTime} (${dateStr})`;
                } else if (isSeller && !isBuyer) {
                    const netEarnings = t.trade_value - t.fee_amount;
                    const earningsStr = `${fmt(netEarnings)} tokens`;
                    const feeStr = t.fee_amount > 0 ? ` (fee: ${fmt(t.fee_amount)})` : '';
                    return `🔴 **SOLD** • \`${t.ticker}\`\n` +
                           `└ **-${t.shares.toLocaleString()}** shares for **${earningsStr}**${feeStr} — ${relativeTime} (${dateStr})`;
                } else {
                    return `🔄 **TRANSFER** • \`${t.ticker}\`\n` +
                           `└ **${t.shares.toLocaleString()}** shares — ${relativeTime} (${dateStr})`;
                }
            });

            const fields = [];

            if (activeOrders.length > 0 && (!requestedTicker || activeOrders.some(o => o.ticker === requestedTicker))) {
                const orderLines = activeOrders
                    .filter(o => !requestedTicker || o.ticker === requestedTicker)
                    .map(o => `⏳ \`${o.ticker}\`: **${o.shares.toLocaleString()}** shares listed at **${fmt(o.list_price)}** tokens/share (<t:${Math.floor(o.timestamp / 1000)}:R>)`);
                if (orderLines.length > 0) {
                    fields.push({
                        name: '📋 Active Sell Orders (Pending)',
                        value: orderLines.join('\n'),
                        inline: false,
                    });
                }
            }

            fields.push({
                name: `Recent Transactions (${trades.length}${requestedTicker ? ` for ${requestedTicker}` : ''})`,
                value: historyLines.length > 0 ? historyLines.join('\n\n') : 'No completed trades for this filter.',
                inline: false,
            });

            const portfolioHoldings = Object.entries(portfolio).filter(([_, count]) => count > 0);
            const holdingSummary = portfolioHoldings.length > 0 
                ? portfolioHoldings.map(([ticker, count]) => `\`${ticker}\`: ${count.toLocaleString()}`).join(' • ')
                : 'None';

            return interaction.editReply({
                embeds: [{
                    title: `📜 Transaction History: ${interaction.user.username}`,
                    description: `Wallet Balance: **${fmt(userRecord.wallet_tokens)} tokens**\nCurrent Portfolio: ${holdingSummary}`,
                    fields,
                    footer: { text: 'IRP Exchange Ledger • Use /stock-sell to list shares' },
                    color: 0x5865F2,
                }],
            });
        }

        // ── /cashout ─────────────────────────────────────────────────────────
        if (commandName === 'cashout') {
            if (!interaction.inGuild()) {
                return interaction.editReply({ content: 'The /cashout command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            }

            const amount = interaction.options.getNumber('amount');
            const user = await getOrCreateUser(interaction.user.id);

            if (amount !== null) {
                const validation = validateCashoutAmount(amount, user.wallet_tokens);
                if (!validation.valid) {
                    return interaction.editReply({ content: `❌ ${validation.reason}`, flags: MessageFlags.Ephemeral });
                }
            }

            const ticketResult = await getOrCreateCashoutTicketChannel(interaction.guild, interaction.user);
            const channel = ticketResult.channel;

            if (amount !== null) {
                const reqResult = await createCashoutRequest(db, {
                    userId: interaction.user.id,
                    amount,
                    channelId: channel.id,
                });

                if (!reqResult.success) {
                    return interaction.editReply({ content: `❌ ${reqResult.error}`, flags: MessageFlags.Ephemeral });
                }

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`cashout:approve:${reqResult.requestId}`)
                        .setLabel('Approve & Complete')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`cashout:reject:${reqResult.requestId}`)
                        .setLabel('Reject Cashout')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('ticket:close')
                        .setLabel('Close Ticket')
                        .setStyle(ButtonStyle.Secondary)
                );

                await channel.send({
                    content: `${interaction.user} <@&${OWNER_ROLE_ID}> <@&${REPRESENTATIVE_ROLE_ID}>`,
                    allowedMentions: {
                        users: [interaction.user.id],
                        roles: [OWNER_ROLE_ID, REPRESENTATIVE_ROLE_ID],
                    },
                    embeds: [{
                        title: `💸 Cashout Request #${reqResult.requestId}`,
                        description: `A new cashout request has been submitted for review.`,
                        fields: [
                            { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
                            { name: 'Requested Amount', value: `**${fmt(amount)} tokens**`, inline: true },
                            { name: 'Available Balance', value: `${fmt(user.wallet_tokens)} tokens`, inline: true },
                            { name: 'Status', value: '🟡 **Pending Admin Review**', inline: true },
                            { name: 'Submission Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                            { name: 'Note', value: 'Tokens remain in user wallet until an admin marks this request as completed.', inline: false },
                        ],
                        color: 0xFEE75C,
                    }],
                    components: [actionRow],
                }).catch(() => {});

                return interaction.editReply({
                    content: `✅ Your cashout request #${reqResult.requestId} for **${fmt(amount)} tokens** has been submitted: ${channel}`,
                });
            } else {
                const promptRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('cashout:open_modal')
                        .setLabel('Enter Cashout Amount')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('ticket:close')
                        .setLabel('Close Ticket')
                        .setStyle(ButtonStyle.Secondary)
                );

                await channel.send({
                    content: `${interaction.user}`,
                    allowedMentions: { users: [interaction.user.id] },
                    embeds: [{
                        title: '💸 Token Cashout Request',
                        description: `Welcome to the cashout desk. You can request up to **${MAX_CASHOUT_AMOUNT.toLocaleString()} tokens** per cashout request.\n\nClick the button below to specify your cashout amount.`,
                        fields: [
                            { name: 'Your Available Balance', value: `${fmt(user.wallet_tokens)} tokens`, inline: true },
                            { name: 'Max Limit Per Request', value: `${MAX_CASHOUT_AMOUNT.toLocaleString()} tokens`, inline: true },
                        ],
                        color: 0x5865F2,
                    }],
                    components: [promptRow],
                }).catch(() => {});

                return interaction.editReply({
                    content: `Your cashout ticket has been opened: ${channel}. Click **Enter Cashout Amount** inside the ticket to submit your request.`,
                });
            }
        }

        // ── /admin-addcompany ─────────────────────────────────────────────────
        if (commandName === 'admin-addcompany') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const ticker = interaction.options.getString('ticker').toUpperCase();
            const name = interaction.options.getString('name');
            const owner = interaction.options.getUser('owner');
            const price = interaction.options.getNumber('price');
            const supply = interaction.options.getInteger('supply');
            const emoji = interaction.options.getString('emoji') ?? '🏢';

            const existing = await db.prepare('SELECT ticker FROM companies WHERE ticker = ?').get(ticker);
            if (existing) return interaction.editReply({ content: `Company **${ticker}** already exists.`, flags: MessageFlags.Ephemeral });

            await db.prepare(`INSERT INTO companies
                (ticker, company_name, owner_id, ipo_share_price, current_price, total_supply, shares_in_circulation, bot_share_reserve, pending_cashout_tokens, all_time_earnings, emoji)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?)
            `).run(ticker, name, owner.id, price, price, supply, supply, emoji);

            await recordPrice(ticker, price);

            return interaction.editReply({
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

        // ── /economy-backup ───────────────────────────────────────────────────
        if (commandName === 'economy-backup') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const code = await generateBackup();
            const buf = Buffer.from(code, 'utf-8');
            const file = new AttachmentBuilder(buf, { name: `economy-backup-${Date.now()}.txt` });
            const userCount = (await db.prepare('SELECT COUNT(*) as n FROM users').get()).n;
            const companyCount = (await db.prepare('SELECT COUNT(*) as n FROM companies').get()).n;
            const histCount = (await db.prepare('SELECT COUNT(*) as n FROM price_history').get()).n;

            return interaction.editReply({
                embeds: [{
                    title: '💾 Economy Backup Generated',
                    description: 'Upload this file to `/economy-restore` to restore the economy to this exact state.',
                    fields: [
                        { name: 'Users', value: `${userCount}`, inline: true },
                        { name: 'Companies', value: `${companyCount}`, inline: true },
                        { name: 'Price Records', value: `${histCount}`, inline: true },
                        { name: 'Snapshot Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    ],
                    color: 0x5865F2,
                }],
                files: [file],
            });
        }

        // ── /economy-restore ──────────────────────────────────────────────────
        if (commandName === 'economy-restore') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const attachment = interaction.options.getAttachment('backup');

            const res = await fetch(attachment.url);
            if (!res.ok) return interaction.editReply({ content: '❌ Failed to download backup file.' });

            const code = await res.text();
            const data = await restoreBackup(code);

            const snapshotTime = data.ts ? `<t:${Math.floor(data.ts / 1000)}:F>` : 'Unknown';
            return interaction.editReply({
                embeds: [{
                    title: '✅ Economy Restored',
                    description: 'All balances, stocks, price history, and sell orders have been restored.',
                    fields: [
                        { name: 'Users Restored', value: `${data.users.length}`, inline: true },
                        { name: 'Companies Restored', value: `${data.companies.length}`, inline: true },
                        { name: 'Price Records', value: `${data.priceHistory.length}`, inline: true },
                        { name: 'Backup Was From', value: snapshotTime, inline: false },
                    ],
                    color: 0x57F287,
                }],
            });
        }

        // ── /setup-tickets ────────────────────────────────────────────────────
        if (commandName === 'setup-tickets') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.' });

            const panelChannel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID);
            if (
                !panelChannel ||
                panelChannel.type !== ChannelType.GuildText ||
                panelChannel.guildId !== interaction.guildId
            ) {
                return interaction.editReply({
                    content: 'The configured ticket panel channel could not be found in this server.',
                });
            }

            const channels = await interaction.guild.channels.fetch();
            const category = channels.find(channel =>
                channel.type === ChannelType.GuildCategory &&
                channel.name === TICKET_CATEGORY_NAME
            );
            if (!category) {
                return interaction.editReply({
                    content: `The ticket category "${TICKET_CATEGORY_NAME}" could not be found.`,
                });
            }

            const [ownerRole, representativeRole] = await Promise.all([
                interaction.guild.roles.fetch(OWNER_ROLE_ID).catch(() => null),
                interaction.guild.roles.fetch(REPRESENTATIVE_ROLE_ID).catch(() => null),
            ]);
            if (!ownerRole || !representativeRole) {
                return interaction.editReply({
                    content: 'The configured Owner or Representative role could not be found in this server.',
                });
            }

            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket:open:buy_tokens')
                    .setLabel('Buy Tokens')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('ticket:open:register_company')
                    .setLabel('Register Company')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket:open:contact_us')
                    .setLabel('Contact Us')
                    .setStyle(ButtonStyle.Secondary)
            );

            await panelChannel.send({
                embeds: [{
                    title: 'IRP Exchange Support',
                    description: 'Choose an option below to open a private support ticket.',
                    color: 0x5865F2,
                }],
                components: [buttonRow],
                allowedMentions: { parse: [] },
            });

            return interaction.editReply({
                content: `Ticket panel posted in ${panelChannel}.`,
            });
        }

        // ── /server-embed ──────────────────────────────────────────────────────
        if (commandName === 'server-embed') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.' });

            const title = interaction.options.getString('title');
            const description = interaction.options.getString('description');
            const colorInput = interaction.options.getString('color');
            const imageUrlInput = interaction.options.getString('image_url');
            const footerText = interaction.options.getString('footer');

            let color;
            let imageUrl;
            try {
                color = parseEmbedColor(colorInput);
                imageUrl = validateImageUrl(imageUrlInput);
            } catch (err) {
                return interaction.editReply({ content: err.message });
            }

            const embed = { title, color };
            if (description) embed.description = description;
            if (imageUrl) embed.image = { url: imageUrl };
            if (footerText) embed.footer = { text: footerText };

            return interaction.editReply({ embeds: [embed] });
        }

        // ── /earnings ─────────────────────────────────────────────────────────
        if (commandName === 'earnings') {
            const companies = await db.prepare('SELECT * FROM companies WHERE owner_id = ?').all(interaction.user.id);
            if (companies.length === 0)
                return interaction.editReply({ content: 'You do not own any companies.' });

            const fields = companies.flatMap(c => [
                { name: `${c.ticker} — ${c.company_name}`, value: `This week: **${fmt(c.pending_cashout_tokens)}** tokens\nAll time: **${fmt(c.all_time_earnings)}** tokens`, inline: false },
            ]);

            return interaction.editReply({
                embeds: [{
                    title: `💼 Your Company Earnings`,
                    fields,
                    color: 0x5865F2,
                }],
                flags: MessageFlags.Ephemeral,
            });
        }

        // ── /today-exchange-stat ───────────────────────────────────────────────
        if (commandName === 'today-exchange-stat') {
            const todayStart = startOfTodayUtc();
            const [stats, activeTraders] = await Promise.all([
                db.prepare(`SELECT
                    COALESCE(SUM(trade_value), 0) AS trading_volume,
                    COUNT(*) AS trades_completed,
                    COUNT(DISTINCT ticker) AS unique_companies,
                    COALESCE(SUM(fee_amount), 0) AS exchange_fees
                    FROM trade_ledger
                    WHERE timestamp >= ?`
                ).get(todayStart),
                db.prepare(`SELECT COUNT(*) AS active_traders
                    FROM (
                        SELECT buyer_id AS trader_id
                        FROM trade_ledger
                        WHERE timestamp >= ?
                        UNION
                        SELECT seller_id AS trader_id
                        FROM trade_ledger
                        WHERE timestamp >= ?
                    )`
                ).get(todayStart, todayStart),
            ]);

            return interaction.editReply({
                embeds: [{
                    title: 'LAX Daily Exchange Report',
                    description: 'Completed stock trade activity for today (UTC).',
                    fields: [
                        { name: 'Trading Volume', value: `${fmt(stats.trading_volume)} tokens`, inline: true },
                        { name: 'Trades Completed', value: `${stats.trades_completed}`, inline: true },
                        { name: 'Unique Companies Traded', value: `${stats.unique_companies}`, inline: true },
                        { name: 'Active Traders', value: `${activeTraders.active_traders}`, inline: true },
                        { name: 'Exchange Fees Earned', value: `${fmt(stats.exchange_fees)} tokens`, inline: true },
                    ],
                    color: 0x5865F2,
                    timestamp: new Date(),
                }],
            });
        }

        // ── /exchange-balance ───────────────────────────────────────────────────
        if (commandName === 'exchange-balance') {
            const todayStart = startOfTodayUtc();
            const [today, allTime] = await Promise.all([
                db.prepare('SELECT COALESCE(SUM(fee_amount), 0) AS fees FROM trade_ledger WHERE timestamp >= ?').get(todayStart),
                db.prepare('SELECT COALESCE(SUM(fee_amount), 0) AS fees FROM trade_ledger').get(),
            ]);

            return interaction.editReply({
                embeds: [{
                    title: '🏛️ IRP Exchange Fee Balances',
                    description: 'Public balance of trading fees collected by the exchange.',
                    fields: [
                        { name: "Today's Fees Earned", value: `${fmt(today.fees)} tokens`, inline: true },
                        { name: 'Total Fees Earned', value: `${fmt(allTime.fees)} tokens`, inline: true },
                        { name: 'Exchange Fee Rate', value: `${(EXCHANGE_FEE_RATE * 100).toFixed(1)}% per trade`, inline: true },
                    ],
                    color: 0x57F287,
                }],
            });
        }

        // ── /sell (Instant Sell to LAX Treasury) ──────────────────────────────
        if (commandName === 'sell') {
            const ticker = interaction.options.getString('ticker').toUpperCase();
            const amount = interaction.options.getInteger('amount');

            const company = await db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
            if (!company) {
                return interaction.editReply({ content: `Company **${ticker}** not found.`, flags: MessageFlags.Ephemeral });
            }

            const [user, laxAccount, cooldown] = await Promise.all([
                getOrCreateUser(interaction.user.id),
                treasury.getLaxAccount(db),
                treasury.getCooldown(db, interaction.user.id),
            ]);

            const validation = treasury.validateInstantSell({
                user,
                company,
                shares: amount,
                laxAccount,
                cooldown,
            });

            if (!validation.valid) {
                return interaction.editReply({ content: validation.reason, flags: MessageFlags.Ephemeral });
            }

            const totalValue = Number((amount * company.current_price).toFixed(8));
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`sell:confirm:${interaction.user.id}:${ticker}:${amount}`)
                    .setLabel(`Confirm Sell (${fmt(totalValue)} tokens)`)
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`sell:cancel:${interaction.user.id}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );

            return interaction.editReply({
                embeds: [{
                    title: `⚡ Instant Sell Confirmation — ${company.company_name} (${ticker})`,
                    description: 'Sell your shares directly to the LAX Treasury for immediate liquidity without waiting for another player.',
                    fields: [
                        { name: 'Company', value: `**${company.company_name}** (\`${ticker}\`)`, inline: true },
                        { name: 'Shares to Sell', value: `**${amount.toLocaleString()}** shares`, inline: true },
                        { name: 'Buyback Price', value: `${fmt(company.current_price)} tokens/share`, inline: true },
                        { name: 'Total Tokens to Receive', value: `**${fmt(totalValue)} tokens**`, inline: true },
                        { name: 'Trading Fee', value: '0% (Exempt from 1% secondary fee)', inline: true },
                        { name: '1-Hour Cooldown', value: 'Starts upon successful confirmation', inline: true },
                    ],
                    color: 0xFEE75C,
                }],
                components: [confirmRow],
            });
        }

        // ── /add-user (Generic Private Ticket System) ─────────────────────────
        if (commandName === 'add-user') {
            if (!interaction.inGuild()) {
                return interaction.editReply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
            }

            if (!ticketUtils.isAuthorizedStaff(interaction)) {
                return interaction.editReply({
                    content: '❌ Unauthorized: Only server Admins, Owners, or Representatives can use /add-user.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const channel = interaction.channel;
            if (!ticketUtils.isTicketChannel(channel)) {
                return interaction.editReply({
                    content: '❌ This command can only be used inside an active ticket channel.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const targetUser = interaction.options.getUser('user');
            const result = await ticketUtils.addUserToTicket({
                channel,
                targetUser,
                executorUser: interaction.user,
            });

            if (!result.success) {
                return interaction.editReply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
            }

            if (result.alreadyPresent) {
                return interaction.editReply({
                    content: `ℹ️ <@${targetUser.id}> already has access to this ticket.`,
                });
            }

            await channel.send({
                content: `👋 <@${targetUser.id}> has been added to this ticket by <@${interaction.user.id}>.`,
                allowedMentions: { users: [targetUser.id] },
            }).catch(() => {});

            return interaction.editReply({
                content: `✅ Successfully added <@${targetUser.id}> to this ticket.`,
            });
        }

        // ── /treasury (Public Treasury Overview) ──────────────────────────────
        if (commandName === 'treasury') {
            const [account, inventory] = await Promise.all([
                treasury.getLaxAccount(db),
                treasury.getTreasuryInventory(db),
            ]);

            const totalSharesHeld = inventory.reduce((sum, item) => sum + item.shares, 0);

            const holdingLines = inventory.length === 0
                ? 'No shares currently held in LAX Treasury.'
                : inventory.map(item => `• **${item.ticker}**: **${item.shares.toLocaleString()}** shares (Acq. Cost: ${fmt(item.total_acquisition_cost)} tokens)`).join('\n');

            return interaction.editReply({
                embeds: [{
                    title: '🏛️ LAX Treasury & Accounting Overview',
                    description: 'Public balance, liquidity accounting, and Treasury share reserves.',
                    fields: [
                        { name: 'LAX Accounting Balance', value: `**${fmt(account.balance)} tokens**`, inline: true },
                        { name: 'Debt Floor', value: `**${fmt(account.debt_floor)} tokens**`, inline: true },
                        { name: 'Instant Sell Status', value: account.kill_switch_enabled ? '🔴 **Disabled**' : '🟢 **Active**', inline: true },
                        { name: 'Realized Profit/Loss', value: `**${fmt(account.realized_pnl)} tokens**`, inline: true },
                        { name: 'Withdrawable Profit', value: `**${fmt(account.withdrawable_profit)} tokens**`, inline: true },
                        { name: 'Total Treasury Shares', value: `**${totalSharesHeld.toLocaleString()} shares**`, inline: true },
                        { name: 'Treasury Share Inventory', value: holdingLines, inline: false },
                    ],
                    color: 0x5865F2,
                }],
            });
        }

        // ── /admin-instant-sell (Admin Treasury Management) ───────────────────
        if (commandName === 'admin-instant-sell') {
            if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

            const action = interaction.options.getString('action');
            const val = interaction.options.getNumber('value');

            if (action === 'status') {
                const [account, inventory] = await Promise.all([
                    treasury.getLaxAccount(db),
                    treasury.getTreasuryInventory(db),
                ]);
                const totalSharesHeld = inventory.reduce((sum, item) => sum + item.shares, 0);
                return interaction.editReply({
                    embeds: [{
                        title: '⚙️ Admin: LAX Treasury & Accounting Status',
                        fields: [
                            { name: 'LAX Cash Balance', value: `${fmt(account.balance)} tokens`, inline: true },
                            { name: 'Debt Floor', value: `${fmt(account.debt_floor)} tokens`, inline: true },
                            { name: 'Kill Switch', value: account.kill_switch_enabled ? '🔴 Disabled' : '🟢 Active', inline: true },
                            { name: 'Realized Profit/Loss', value: `${fmt(account.realized_pnl)} tokens`, inline: true },
                            { name: 'Total Withdrawn', value: `${fmt(account.total_withdrawn)} tokens`, inline: true },
                            { name: 'Withdrawable Profit', value: `${fmt(account.withdrawable_profit)} tokens`, inline: true },
                            { name: 'Treasury Companies', value: `${inventory.length}`, inline: true },
                            { name: 'Total Shares Held', value: `${totalSharesHeld}`, inline: true },
                        ],
                        color: 0x5865F2,
                    }]
                });
            }

            if (action === 'toggle-killswitch') {
                const account = await treasury.getLaxAccount(db);
                const newState = !account.kill_switch_enabled;
                await treasury.setKillSwitch(db, newState);
                return interaction.editReply({
                    content: `✅ Instant Sell kill switch has been **${newState ? 'ENABLED (Instant Sell Disabled)' : 'DISABLED (Instant Sell Active)'}**.`,
                });
            }

            if (action === 'set-debt-floor') {
                if (val === null || isNaN(val) || val > 0) {
                    return interaction.editReply({ content: '❌ Please provide a negative number or zero for debt floor (e.g. -10000).' });
                }
                await treasury.setDebtFloor(db, val);
                return interaction.editReply({ content: `✅ LAX debt floor set to **${fmt(val)} tokens**.` });
            }

            if (action === 'withdraw-profit') {
                if (val === null || isNaN(val) || val <= 0) {
                    return interaction.editReply({ content: '❌ Please provide a positive amount of profit to withdraw.' });
                }
                const res = await treasury.withdrawRealizedProfit(db, { ownerId: interaction.user.id, amount: val });
                if (!res.success) {
                    return interaction.editReply({ content: `❌ ${res.error}` });
                }
                return interaction.editReply({
                    content: `✅ Successfully withdrew **${fmt(res.withdrawnAmount)} tokens** of realized profit to your wallet. Remaining withdrawable profit: **${fmt(res.remainingWithdrawable)} tokens**.`,
                });
            }
        }

    } catch (err) {
        console.error(`Error in /${commandName}:`, err);
        const msg = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
        await interaction.editReply(msg).catch(() => {});
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (
        message.author.bot ||
        !client.user ||
        !message.mentions.users.has(client.user.id)
    ) {
        return;
    }

    try {
        await message.reply({
            content: 'I am just a utility bot and cannot help you with any task. Ask owner or representative for support.\n\nNote: I am not an AI',
            allowedMentions: { repliedUser: false },
        });
    } catch (error) {
        console.error('Failed to send mention auto-reply:', error);
    }
});

if (process.env.TOKEN) {
    client.login(process.env.TOKEN).catch(err => {
        console.error('Failed to log in to Discord:', err.message);
    });
} else {
    console.warn('Discord TOKEN not provided in environment variables.');
}

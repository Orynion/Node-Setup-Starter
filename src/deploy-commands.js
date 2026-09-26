const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
require('dotenv').config();

const commands = [
    new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Shows your wallet tokens and stock portfolio'),

    new SlashCommandBuilder()
        .setName('admin-add-money')
        .setDescription('Admin: Add tokens to a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addNumberOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true).setMinValue(0.01))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('admin-remove-money')
        .setDescription('Admin: Remove tokens from a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addNumberOption(o => o.setName('amount').setDescription('Amount to remove').setRequired(true).setMinValue(0.01))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Top 10 richest users by wallet tokens'),

    new SlashCommandBuilder()
        .setName('stock-buy')
        .setDescription('Buy shares of a company')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Number of shares to buy').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
        .setName('stock-sell')
        .setDescription('List your shares for sale at current price')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Number of shares to list').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
        .setName('sell-cancel')
        .setDescription('Cancel your active sell listings and return shares to your portfolio')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Number of shares to cancel (default: all)').setRequired(false).setMinValue(1)),

    new SlashCommandBuilder()
        .setName('stock-info')
        .setDescription('View company stock information')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true)),

    new SlashCommandBuilder()
        .setName('stock-list')
        .setDescription('View all listed companies'),

    new SlashCommandBuilder()
        .setName('chart')
        .setDescription('View price history chart for a company')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true)),

    new SlashCommandBuilder()
        .setName('admin-addcompany')
        .setDescription('Admin: Register a new company IPO')
        .addStringOption(o => o.setName('ticker').setDescription('Ticker symbol (e.g. ACME)').setRequired(true))
        .addStringOption(o => o.setName('name').setDescription('Company name').setRequired(true))
        .addUserOption(o => o.setName('owner').setDescription('Company owner').setRequired(true))
        .addNumberOption(o => o.setName('price').setDescription('IPO share price').setRequired(true).setMinValue(0.01))
        .addIntegerOption(o => o.setName('supply').setDescription('Total share supply').setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName('emoji').setDescription('Company emoji (e.g. 🚀)').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('admin-removecompany')
        .setDescription('Admin: Remove a company (test use only)')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true))
        .addStringOption(o => o.setName('confirm').setDescription('Confirm removal (default: yes)').setRequired(false)
            .addChoices({ name: 'yes', value: 'yes' }, { name: 'no', value: 'no' }))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('admin-editcompany')
        .setDescription('Admin: Edit an existing company')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true))
        .addStringOption(o => o.setName('name').setDescription('New company name').setRequired(false))
        .addUserOption(o => o.setName('owner').setDescription('New owner').setRequired(false))
        .addNumberOption(o => o.setName('price').setDescription('New current price').setRequired(false).setMinValue(0.01))
        .addStringOption(o => o.setName('emoji').setDescription('New emoji').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('provide-shares')
        .setDescription('Company Owner/Admin: Transfer unallocated reserve shares to a user')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true))
        .addUserOption(o => o.setName('user').setDescription('Recipient user').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Number of shares to provide').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
        .setName('earnings')
        .setDescription('View your company earnings this week and all time'),

    new SlashCommandBuilder()
        .setName('today-exchange-stat')
        .setDescription("View today's exchange trading report"),

    new SlashCommandBuilder()
        .setName('exchange-balance')
        .setDescription('Admin: View exchange fee balances')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('economy-backup')
        .setDescription('Admin: Generate a full economy backup file')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('economy-restore')
        .setDescription('Admin: Restore economy from a backup file')
        .addAttachmentOption(o => o.setName('backup').setDescription('The backup .txt file generated by /economy-backup').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('setup-tickets')
        .setDescription('Admin: Post the IRP Exchange Support ticket panel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('server-embed')
        .setDescription('Admin: Post a custom rich embed in this channel')
        .addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true).setMaxLength(256))
        .addStringOption(o => o.setName('description').setDescription('Embed description').setRequired(false).setMaxLength(4096))
        .addStringOption(o => o.setName('color').setDescription('Hex color, for example #5865F2').setRequired(false).setMaxLength(8))
        .addStringOption(o => o.setName('image_url').setDescription('Image URL beginning with http:// or https://').setRequired(false).setMaxLength(2048))
        .addStringOption(o => o.setName('footer').setDescription('Footer text').setRequired(false).setMaxLength(2048))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

async function registerCommands(targetGuildId, clientInstance) {
    if (!process.env.TOKEN || !process.env.CLIENT_ID) {
        console.warn('Discord TOKEN or CLIENT_ID not provided. Skipping slash command registration.');
        return;
    }
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    const clientId = process.env.CLIENT_ID;

    // 1. Clear global commands to ensure no duplicate global registration exists
    try {
        console.log('Clearing any global commands to prevent duplicate registration...');
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: [] }
        );
        console.log('Global slash commands cleared.');
    } catch (error) {
        console.warn('Note: Could not clear global commands:', error.message);
    }

    // 2. Resolve target guild ID(s)
    let guildIds = [];
    if (targetGuildId) {
        guildIds = [targetGuildId];
    } else if (process.env.GUILD_ID || process.env.SERVER_ID || process.env.DISCORD_GUILD_ID) {
        const rawGuilds = (process.env.GUILD_ID || process.env.SERVER_ID || process.env.DISCORD_GUILD_ID).trim();
        guildIds = rawGuilds.split(',').map(id => id.trim()).filter(Boolean);
    } else if (clientInstance?.guilds?.cache?.size) {
        guildIds = Array.from(clientInstance.guilds.cache.keys());
    }

    if (guildIds.length === 0) {
        console.warn('No GUILD_ID provided in environment variables and no cached guilds found. Guild commands could not be deployed.');
        return;
    }

    // 3. Register commands for each targeted guild
    for (const guildId of guildIds) {
        try {
            console.log(`Registering ${commands.length} guild slash commands for guild: ${guildId}...`);
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: commands }
            );
            console.log(`Guild slash commands successfully registered for guild ${guildId}!`);
        } catch (error) {
            console.error(`Failed to register guild commands for guild ${guildId}:`, error);
        }
    }
}

if (require.main === module) {
    registerCommands();
}

module.exports = { registerCommands, commands };

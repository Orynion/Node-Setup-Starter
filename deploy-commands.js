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
        .setName('earnings')
        .setDescription('View your company earnings this week and all time'),

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
        .setName('server-embed')
        .setDescription('Admin: Post a custom rich embed in this channel')
        .addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true).setMaxLength(256))
        .addStringOption(o => o.setName('description').setDescription('Embed description').setRequired(false).setMaxLength(4096))
        .addStringOption(o => o.setName('color').setDescription('Hex color, for example #5865F2').setRequired(false).setMaxLength(8))
        .addStringOption(o => o.setName('image_url').setDescription('Image URL beginning with http:// or https://').setRequired(false).setMaxLength(2048))
        .addStringOption(o => o.setName('footer').setDescription('Footer text').setRequired(false).setMaxLength(2048))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

async function registerCommands() {
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered!');
    } catch (error) {
        console.error('Failed to register commands:', error);
    }
}

module.exports = { registerCommands };

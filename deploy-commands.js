const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
    new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Shows your wallet tokens and stock portfolio'),

    new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Transfer tokens to another user')
        .addUserOption(o => o.setName('user').setDescription('User to pay').setRequired(true))
        .addNumberOption(o => o.setName('amount').setDescription('Amount to transfer').setRequired(true).setMinValue(0.01)),

    new SlashCommandBuilder()
        .setName('admin-add-money')
        .setDescription('Admin: Add tokens to a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addNumberOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true).setMinValue(0.01)),

    new SlashCommandBuilder()
        .setName('admin-remove-money')
        .setDescription('Admin: Remove tokens from a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addNumberOption(o => o.setName('amount').setDescription('Amount to remove').setRequired(true).setMinValue(0.01)),

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
        .addNumberOption(o => o.setName('price').setDescription('IPO share price').setRequired(true).setMinValue(0.01))
        .addIntegerOption(o => o.setName('supply').setDescription('Total share supply').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
        .setName('admin-settle')
        .setDescription('Admin: Show weekly payout invoice and reset pending cashout')
        .addStringOption(o => o.setName('ticker').setDescription('Company ticker symbol').setRequired(true)),

    new SlashCommandBuilder()
        .setName('earnings')
        .setDescription('View your company earnings this week and all time'),
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

const { Client, GatewayIntentBits, Events } = require('discord.js');
require('dotenv').config();
const db = require('./database.js');
const { registerCommands } = require('./deploy-commands.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
    console.log('Bot is online!');
    console.log('Database ready!');
    await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'balance') {
        const userId = interaction.user.id;

        let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(userId);

        if (!user) {
            db.prepare('INSERT INTO users (discord_id, wallet_tokens, portfolio) VALUES (?, 0, ?)').run(userId, '{}');
            user = { discord_id: userId, wallet_tokens: 0, portfolio: '{}' };
        }

        const portfolio = JSON.parse(user.portfolio);
        const portfolioEntries = Object.entries(portfolio);

        let portfolioText = '';
        if (portfolioEntries.length === 0) {
            portfolioText = 'No stocks owned.';
        } else {
            portfolioText = portfolioEntries
                .map(([ticker, shares]) => `**${ticker}**: ${shares} share${shares !== 1 ? 's' : ''}`)
                .join('\n');
        }

        await interaction.reply({
            embeds: [{
                title: `${interaction.user.username}'s Balance`,
                fields: [
                    { name: 'Wallet Tokens', value: `${user.wallet_tokens.toLocaleString()} tokens`, inline: false },
                    { name: 'Stock Portfolio', value: portfolioText, inline: false }
                ],
                color: 0x5865F2
            }]
        });
    }
});

client.login(process.env.TOKEN);

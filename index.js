const { Client, GatewayIntentBits, Events } = require('discord.js');
require('dotenv').config();
require('./database.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
    console.log('Bot is online!');
    console.log('Database ready!');
});

client.login(process.env.TOKEN);

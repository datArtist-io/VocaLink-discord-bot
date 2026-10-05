/** npm run register  — (re)register slash commands. DEV_GUILD_ID registers instantly to one server. */

import { REST, Routes } from 'discord.js';

import { COMMANDS } from './discord/commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required');
const guild = process.env.DEV_GUILD_ID;
const rest = new REST().setToken(token);
const route = guild ? Routes.applicationGuildCommands(clientId, guild) : Routes.applicationCommands(clientId);
await rest.put(route, { body: COMMANDS });
console.log(`Registered ${COMMANDS.length} commands ${guild ? `to guild ${guild}` : 'globally (may take up to an hour to appear)'}.`);

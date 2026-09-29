// Registers the /translate slash command with Discord. Run this once (and again
// any time you change the command definitions below) with: npm run deploy-commands
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Live voice-channel translation')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Join your voice channel and start posting live translated captions')
        .addChannelOption(opt =>
          opt.setName('captions_channel')
            .setDescription('Text channel to post captions in (defaults to this channel)')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('target')
            .setDescription('Language to translate into, e.g. "English", "Yoruba", "Brazilian Portuguese" (default: English)')
            .setRequired(false))
        .addBooleanOption(opt =>
          opt.setName('dub')
            .setDescription('Also speak translations aloud into the channel, in cloned voices where enrolled (default: off)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('Stop translating and leave the voice channel'))
    .addSubcommand(sub =>
      sub.setName('enroll-voice')
        .setDescription('Let the bot clone YOUR voice (for spoken translations of you) — only ever your own voice')
        .addAttachmentOption(opt =>
          opt.setName('sample')
            .setDescription('30-60s of clean audio of you talking (voice memo, etc.)')
            .setRequired(true))
        .addBooleanOption(opt =>
          opt.setName('consent')
            .setDescription('Required: confirm this is your own voice and you consent to it being cloned')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove-voice')
        .setDescription('Delete your enrolled voice clone'))
    .addSubcommand(sub =>
      sub.setName('voices')
        .setDescription('List who has enrolled their voice for cloned dubbing'))
    // Left open to all members by default so anyone can self-enroll their own
    // voice — Discord applies default_member_permissions to the whole command,
    // not per subcommand. If you want start/stop restricted to admins, do it in
    // Server Settings -> Integrations -> [this bot], which lets you override
    // permissions per subcommand.
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log('Registering /translate command...');
  await rest.put(
    Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
    { body: commands }
  );
  console.log('Done. It can take up to an hour to show up everywhere the first time.');
} catch (err) {
  console.error(err);
}

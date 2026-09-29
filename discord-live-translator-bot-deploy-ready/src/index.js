import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import prism from 'prism-media';
import { pcmToWav } from './wav.js';
import { transcribeUtterance } from './deepgram.js';
import { translate } from './translate.js';
import { cloneVoice, synthesizeSpeech, DEFAULT_VOICE_ID } from './elevenlabs.js';
import { getVoice, setVoice, removeVoice } from './voiceStore.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// One entry per guild currently running translation.
// { connection, receiver, captionsChannel, targetLang, activeUsers: Set<userId> }
const sessions = new Map();

const MIN_UTTERANCE_MS = 400;    // ignore blips shorter than this (mic pops, coughs)
const MAX_UTTERANCE_MS = 20000;  // hard cap so a stuck stream can't run forever
const SILENCE_MS = 700;          // how long a user must be quiet before we call the utterance "done"

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'translate') return;

  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    await handleStart(interaction);
  } else if (sub === 'stop') {
    await handleStop(interaction);
  } else if (sub === 'enroll-voice') {
    await handleEnrollVoice(interaction);
  } else if (sub === 'remove-voice') {
    await handleRemoveVoice(interaction);
  } else if (sub === 'voices') {
    await handleListVoices(interaction);
  }
});

async function handleStart(interaction) {
  const member = interaction.member;
  const voiceChannel = member.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'Join a voice channel first, then run this again.', ephemeral: true });
    return;
  }
  if (sessions.has(interaction.guildId)) {
    await interaction.reply({ content: 'Already running in this server. Use `/translate stop` first.', ephemeral: true });
    return;
  }

  const captionsChannel = interaction.options.getChannel('captions_channel') ?? interaction.channel;
  const targetLang = interaction.options.getString('target') ?? 'English';
  const dub = interaction.options.getBoolean('dub') ?? false;

  await interaction.deferReply();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false // we need to actually receive audio
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch (err) {
    connection.destroy();
    await interaction.editReply('Could not connect to the voice channel — try again.');
    return;
  }

  const receiver = connection.receiver;
  const player = createAudioPlayer();
  connection.subscribe(player);

  const session = {
    connection,
    receiver,
    captionsChannel,
    targetLang,
    dub,
    player,
    playbackQueue: [],
    isPlaying: false,
    activeUsers: new Set()
  };
  sessions.set(interaction.guildId, session);

  player.on(AudioPlayerStatus.Idle, () => playNextInQueue(session));

  receiver.speaking.on('start', (userId) => {
    // Never transcribe the bot's own output — avoids feedback loops once TTS is added,
    // and avoids the bot picking up other bots' audio.
    if (userId === client.user.id) return;
    if (session.activeUsers.has(userId)) return; // already capturing this user's current utterance
    handleUtterance(interaction.guildId, userId).catch(err =>
      console.error('Utterance handling failed:', err)
    );
  });

  await interaction.editReply(
    `Listening in **${voiceChannel.name}** → posting ${targetLang} captions in ${captionsChannel}` +
    (dub ? ', speaking dubbed translations into the channel (cloned voice where enrolled).' : '.') +
    ' Use `/translate stop` to end.'
  );
}

// Plays queued dub clips one at a time so translations from different
// speakers don't overlap into a garbled mess.
function playNextInQueue(session) {
  if (session.playbackQueue.length === 0) {
    session.isPlaying = false;
    return;
  }
  session.isPlaying = true;
  const mp3Buffer = session.playbackQueue.shift();
  const resource = createAudioResource(Readable.from(mp3Buffer), { inputType: StreamType.Arbitrary });
  session.player.play(resource);
}

async function handleUtterance(guildId, userId) {
  const session = sessions.get(guildId);
  if (!session) return;
  session.activeUsers.add(userId);

  try {
    const opusStream = session.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS }
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    const startedAt = Date.now();

    opusStream.pipe(decoder);

    for await (const chunk of decoder) {
      chunks.push(chunk);
      if (Date.now() - startedAt > MAX_UTTERANCE_MS) {
        opusStream.destroy();
        break;
      }
    }

    const durationMs = Date.now() - startedAt;
    if (durationMs < MIN_UTTERANCE_MS || chunks.length === 0) return;

    const pcm = Buffer.concat(chunks);
    const wav = pcmToWav(pcm, { sampleRate: 48000, channels: 2 });

    const { transcript, detectedLanguage } = await transcribeUtterance(wav);
    if (!transcript) return;

    const translated = await translate(transcript, {
      targetLang: session.targetLang,
      sourceLang: detectedLanguage
    });
    if (!translated || translated === '…') return;

    const guild = client.guilds.cache.get(guildId);
    const displayName = guild?.members.cache.get(userId)?.displayName ?? `<@${userId}>`;

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${displayName} (${detectedLanguage})` })
      .setDescription(`🗣️ ${transcript}\n➡️ **${translated}**`)
      .setColor(0x5865F2);

    await session.captionsChannel.send({ embeds: [embed] });

    if (session.dub) {
      const enrolled = getVoice(userId);
      const voiceId = enrolled?.voiceId ?? DEFAULT_VOICE_ID;
      try {
        const mp3 = await synthesizeSpeech(translated, voiceId);
        session.playbackQueue.push(mp3);
        if (!session.isPlaying) playNextInQueue(session);
      } catch (err) {
        console.error('Dubbing TTS failed:', err);
      }
    }
  } finally {
    session.activeUsers.delete(userId);
  }
}

async function handleEnrollVoice(interaction) {
  const consent = interaction.options.getBoolean('consent');
  const attachment = interaction.options.getAttachment('sample');

  if (!consent) {
    await interaction.reply({
      content: 'Voice cloning needs your explicit consent — re-run this with `consent: true` only if the sample really is your own voice and you\'re okay with it being cloned.',
      ephemeral: true
    });
    return;
  }
  if (!attachment.contentType?.startsWith('audio/')) {
    await interaction.reply({ content: 'That attachment doesn\'t look like an audio file — try a voice memo (m4a/mp3/wav/ogg).', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const res = await fetch(attachment.url);
    const buffer = Buffer.from(await res.arrayBuffer());

    const voiceId = await cloneVoice({
      buffer,
      filename: attachment.name,
      mimeType: attachment.contentType,
      name: `discord-${interaction.user.username}-${interaction.user.id}`
    });

    setVoice(interaction.user.id, voiceId);
    await interaction.editReply(
      'Your voice is enrolled. When dubbing is on (`/translate start dub:true`), your translated speech will play in your own cloned voice. Run `/translate remove-voice` any time to delete it.'
    );
  } catch (err) {
    console.error('Voice enrollment failed:', err);
    await interaction.editReply('Something went wrong cloning that sample — try a shorter, cleaner clip (30-60s, one speaker, minimal background noise).');
  }
}

async function handleRemoveVoice(interaction) {
  const existing = getVoice(interaction.user.id);
  if (!existing) {
    await interaction.reply({ content: 'You don\'t have an enrolled voice.', ephemeral: true });
    return;
  }
  removeVoice(interaction.user.id);
  await interaction.reply({ content: 'Your voice clone has been removed.', ephemeral: true });
}

async function handleListVoices(interaction) {
  // Voices are stored by user ID only — this just reports who's enrolled,
  // it doesn't expose anyone's audio or the underlying voice ID.
  const guild = interaction.guild;
  await guild.members.fetch();
  const enrolled = guild.members.cache.filter(m => getVoice(m.id));

  if (enrolled.size === 0) {
    await interaction.reply('No one in this server has enrolled their voice yet.');
    return;
  }
  const names = enrolled.map(m => `• ${m.displayName}`).join('\n');
  await interaction.reply(`Enrolled for cloned dubbing:\n${names}`);
}

async function handleStop(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: 'Not currently running in this server.', ephemeral: true });
    return;
  }

  session.connection.destroy();
  sessions.delete(interaction.guildId);
  await interaction.reply('Stopped translating and left the voice channel.');
}

client.login(process.env.DISCORD_TOKEN);

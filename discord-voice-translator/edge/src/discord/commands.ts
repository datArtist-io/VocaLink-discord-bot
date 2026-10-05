/**
 * Application command definitions (raw API JSON, registered by
 * register-commands.ts or on start-up). Guild-only (contexts: [0]).
 */

const SUB = 1;
const STRING = 3;
const BOOLEAN = 5;
const USER = 6;
const CHANNEL = 7;
const MANAGE_GUILD = String(1 << 5);
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;

const lang = (name: string, description: string, required = false) => ({ type: STRING, name, description, required, autocomplete: true });

export const COMMANDS = [
  {
    name: 'translate',
    description: 'Live voice translation in your current voice channel',
    contexts: [0],
    options: [
      {
        type: SUB, name: 'start', description: 'Join your voice channel and start translating',
        options: [
          { type: CHANNEL, name: 'captions', description: 'Text channel for captions (default: this channel)', channel_types: [GUILD_TEXT, GUILD_ANNOUNCEMENT], required: false },
          lang('dub', 'Speak translations into the voice channel in this language (default: server setting)'),
        ],
      },
      { type: SUB, name: 'stop', description: 'Stop translating and post the call summary' },
      { type: SUB, name: 'status', description: 'Show pipeline status, latency and language tiers' },
    ],
  },
  {
    name: 'mylang',
    description: 'Set the language you speak and the language you want to read/hear',
    contexts: [0],
    options: [lang('speak', 'Language you speak ("auto" = detect, recommended)'), lang('hear', 'Language you want translations in')],
  },
  {
    name: 'settings',
    description: 'Server translation settings',
    contexts: [0],
    default_member_permissions: MANAGE_GUILD,
    options: [
      { type: SUB, name: 'view', description: 'Show current settings' },
      {
        type: SUB, name: 'set', description: 'Change settings',
        options: [
          { type: STRING, name: 'captions', description: 'Caption languages, comma-separated (e.g. "en, fr, yo")' },
          { type: STRING, name: 'dub', description: 'Voice dubbing language for the channel, or "off"', autocomplete: true },
          { type: STRING, name: 'mode', description: 'Translation style', choices: [
            { name: 'literal (fast, local NMT)', value: 'literal' }, { name: 'natural (needs an LLM)', value: 'natural' },
            { name: 'cultural (adapt idioms, needs an LLM)', value: 'cultural' }] },
          { type: STRING, name: 'voice', description: 'Dub voice', choices: [
            { name: 'house voice', value: 'house' }, { name: 'cloned voice of consenting speakers', value: 'clone' }] },
          { type: BOOLEAN, name: 'mirrors', description: 'Create one listen-only mirror voice channel per language (needs extra bot tokens)' },
          { type: STRING, name: 'mirror_langs', description: 'Languages for mirror channels, comma-separated' },
          { type: BOOLEAN, name: 'summaries', description: 'Keep an in-memory transcript for the post-call summary' },
          { type: STRING, name: 'expected', description: 'Languages expected in this server (improves detection), or "auto"' },
          { type: BOOLEAN, name: 'threads', description: 'Post captions in a thread (default on)' },
        ],
      },
    ],
  },
  { name: 'optout', description: 'Never translate or process my voice (takes effect immediately)', contexts: [0] },
  { name: 'optin', description: 'Allow my voice to be translated again', contexts: [0] },
  {
    name: 'voice',
    description: 'Voice cloning for dubbing in your own voice (opt-in)',
    contexts: [0],
    options: [
      { type: SUB, name: 'enroll', description: 'Consent and record a short phrase to create your voice profile' },
      { type: SUB, name: 'delete', description: 'Delete your voice profile immediately' },
      { type: SUB, name: 'status', description: 'Show whether you have a voice profile' },
    ],
  },
  {
    name: 'glossary',
    description: 'Server glossary (names and terms translated your way)',
    contexts: [0],
    options: [
      {
        type: SUB, name: 'add', description: 'Add or update a term',
        options: [
          { type: STRING, name: 'source', description: 'Term as spoken', required: true },
          { type: STRING, name: 'target', description: 'How it must appear in translations', required: true },
          lang('from', 'Only when spoken in this language (default: any)'),
          lang('to', 'Only when translating into this language (default: any)'),
        ],
      },
      { type: SUB, name: 'remove', description: 'Remove a term', options: [{ type: 4, name: 'id', description: 'Term id from /glossary list', required: true }] },
      { type: SUB, name: 'list', description: 'List terms and learned corrections' },
    ],
  },
  {
    name: 'correct',
    description: 'Correct the last translation of a caption (the bot learns small fixes)',
    contexts: [0],
    options: [
      { type: STRING, name: 'message', description: 'Link or id of the caption message', required: true },
      lang('lang', 'Which translation to correct', true),
      { type: STRING, name: 'text', description: 'The corrected translation', required: true },
    ],
  },
  { name: 'Correct translation', type: 3, contexts: [0] },
  {
    name: 'whisper',
    description: 'Private translation',
    contexts: [0],
    options: [
      { type: SUB, name: 'on', description: 'DM me live translations in my /mylang hear language' },
      { type: SUB, name: 'off', description: 'Stop DM translations' },
      {
        type: SUB, name: 'send', description: 'Send someone a private message translated into their language',
        options: [
          { type: USER, name: 'to', description: 'Recipient', required: true },
          { type: STRING, name: 'text', description: 'Your message', required: true },
        ],
      },
    ],
  },
  { name: 'summary', description: 'Post a multilingual summary of the call so far', contexts: [0], options: [lang('lang', 'Extra summary language')] },
  { name: 'listen', description: 'Get your personal translated audio + captions link (web companion)', contexts: [0], options: [lang('lang', 'Language to hear')] },
  { name: 'languages', description: 'Which languages get cloned voice, standard voice or captions', contexts: [0], options: [lang('code', 'Show one language in detail')] },
  { name: 'dashboard', description: 'Analytics dashboard link', contexts: [0], default_member_permissions: MANAGE_GUILD },
];

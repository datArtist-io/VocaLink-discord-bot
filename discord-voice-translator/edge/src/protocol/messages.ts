/** Typed views of the JSON messages exchanged with the worker. */

export interface LatencyMarks {
  vad_endpoint?: number;
  stt?: number;
  mt?: number;
  tts_first_audio?: number;
  [k: string]: number | undefined;
}

export interface TranslationOut {
  text: string | null;
  provider: string | null;
  mode: string | null;
  note: string;
}

export interface FinalEvent {
  type: 'final';
  sid: number;
  utt_id: number;
  user_id: string;
  lang: string;
  lang_prob: number;
  lid_reason: string;
  segments: { lang: string; text: string }[];
  text: string;
  confidence: number;
  flags: string[];
  translations: Record<string, TranslationOut>;
  tiers: Record<string, number>;
  stt_provider: string;
  duration_s: number;
  endpoint_reason: string;
  latency: LatencyMarks;
}

export interface PartialEvent {
  type: 'partial';
  sid: number;
  utt_id: number;
  lang: string;
  committed: string;
  tentative: string;
}

export interface PartialTranslationEvent {
  type: 'partial_translation';
  sid: number;
  utt_id: number;
  lang: string;
  translations: Record<string, string>;
}

export interface TtsStartEvent {
  type: 'tts_start';
  dub_id: number;
  sid: number;
  utt_id: number;
  user_id: string;
  lang: string;
  text: string;
  tier: number;
  voice: 'clone' | 'house' | null;
  provider: string | null;
  incremental: boolean;
  sample_rate: number;
}

export interface TtsEndEvent {
  type: 'tts_end';
  dub_id: number;
  cancelled: boolean;
  reason: string;
  truncated: string | null;
  frames: number;
  latency: LatencyMarks;
}

export interface NoticeEvent {
  type: 'notice';
  sid?: number;
  utt_id?: number;
  level: 'info' | 'warn';
  code: string;
  message: string;
}

export interface LangSwitchEvent {
  type: 'lang_switch';
  sid: number;
  utt_id: number;
  from: string | null;
  to: string;
  reason: string;
}

export interface LanguageInfo {
  tier: number;
  stt: string;
  auto: boolean;
  name: string;
  reasons: string[];
}

export interface HelloAck {
  type: 'hello_ack';
  protocol: number;
  worker_version: string;
  hardware: { tier: string; device: string; gpu_name: string; vram_gb: number; cpu_cores: number };
  plan: Record<string, unknown>;
  policy: { mode: string; commercial: boolean; store_audio: boolean };
  providers: { stage: string; name: string; status: string; reason?: string }[];
  registry_summary: { counts: Record<string, number>; targets_by_tier: Record<string, string[]> };
  languages: Record<string, LanguageInfo>;
  voice_cloning: { enabled: boolean; reason: string };
}

export interface GuildConfigMsg {
  type: 'guild_config';
  guild_id: string;
  text_targets: string[];
  audio_targets: string[];
  mode: 'literal' | 'natural' | 'cultural';
  voice_mode: 'house' | 'clone';
  expected_langs: string[] | null;
  glossary: { source: string; target: string; src_lang: string; tgt_lang: string; kind: string }[];
  clone_users: string[];
  summaries: boolean;
  [k: string]: unknown;
}

export type WorkerEvent =
  | FinalEvent
  | PartialEvent
  | PartialTranslationEvent
  | TtsStartEvent
  | TtsEndEvent
  | NoticeEvent
  | LangSwitchEvent
  | { type: 'speech_start'; sid: number; utt_id: number }
  | { type: 'discard'; sid: number; utt_id: number; reason: string }
  | { type: 'error'; sid?: number; message: string; stage?: string }
  | { type: 'metrics'; [k: string]: unknown };

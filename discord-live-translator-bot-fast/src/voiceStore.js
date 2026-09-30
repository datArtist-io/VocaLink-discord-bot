// Deliberately dumb persistence: one JSON file, loaded at startup, rewritten on
// every change. Fine for a friends server; swap for a real DB if this grows.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'voices.json');

function load() {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let store = load();

function save() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2));
}

// { voiceId, enrolledAt } keyed by Discord user ID — only ever written by
// enroll-voice, which only lets a user enroll their own voice.
export function getVoice(userId) {
  return store[userId] ?? null;
}

export function setVoice(userId, voiceId) {
  store[userId] = { voiceId, enrolledAt: new Date().toISOString() };
  save();
}

export function removeVoice(userId) {
  delete store[userId];
  save();
}

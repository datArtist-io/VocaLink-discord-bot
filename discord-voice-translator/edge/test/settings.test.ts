import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store/Store.js';

const db = () => join(mkdtempSync(join(tmpdir(), 'vl-')), 'edge.sqlite');

test('new servers: channel loudspeaker off (everyone uses their own player), EN+TL captions', () => {
  const s = new Store(db()).getSettings('g1');
  assert.equal(s.dubLang, null);
  assert.deepEqual(s.textTargets, ['en', 'tl']);
  assert.equal(s.expectedLangs, null); // server languages are the hints
  assert.equal(s.captions, true);
});

test('old rows that only held the old defaults move to the new defaults; real choices are kept', () => {
  const path = db();
  new Store(path).close();
  const raw = new DatabaseSync(path);
  const put = raw.prepare('INSERT INTO guild_settings(guild_id, json, updated_at) VALUES (?, ?, ?)');
  put.run('old', JSON.stringify({ textTargets: ['en'], dubLang: null, summaries: true, expectedLangs: null }), 1);
  put.run('chose', JSON.stringify({ textTargets: ['en', 'ja'], dubLang: 'ja' }), 1);
  put.run('v2auto', JSON.stringify({ textTargets: ['en', 'tl'], dubLang: 'auto', v: 2 }), 1);
  raw.close();
  const st = new Store(path);
  assert.equal(st.getSettings('old').dubLang, null);
  assert.deepEqual(st.getSettings('old').textTargets, ['en', 'tl']);
  assert.equal(st.getSettings('chose').dubLang, 'ja');
  assert.equal(st.getSettings('v2auto').dubLang, null); // the old "auto" default becomes off
  // after an explicit "off" under the new version, it stays off
  st.updateSettings('old', { dubLang: null });
  assert.equal(st.getSettings('old').dubLang, null);
});

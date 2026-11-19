import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Billing, formatHours } from '../src/billing/Billing.js';
import { Store } from '../src/store/Store.js';
import { WebHub } from '../src/web/hub.js';

const ent = (id: string, skuId: string, guildId: string | null, extra: Record<string, unknown> = {}) => ({ id, skuId, guildId, ...extra });

test('without shop SKUs, plans are off: every server is unlimited with AI voices', () => {
  const b = new Billing(new Store(':memory:'));
  assert.equal(b.enabled, false);
  const p = b.planOf('g1');
  assert.equal(p.aiVoice, true);
  assert.equal(b.remainingSeconds('g1'), Infinity);
});

test('a purchase in the Discord shop unlocks the plan for that server only', () => {
  const b = new Billing(new Store(':memory:'), { skuPlus: 'sku-plus', skuPro: 'sku-pro' });
  assert.equal(b.planOf('g1').id, 'free');
  b.upsert(ent('e1', 'sku-plus', 'g1'));
  assert.equal(b.planOf('g1').id, 'plus');
  assert.equal(b.planOf('g2').id, 'free');
  b.upsert(ent('e2', 'sku-pro', 'g1'));
  assert.equal(b.planOf('g1').id, 'pro', 'Pro wins when a server has both');
  assert.equal(b.planOf('g1').aiVoice, true);
  assert.equal(b.planOf('g1').ownVoice, true);
  b.remove({ id: 'e2', guildId: 'g1' });
  assert.equal(b.planOf('g1').id, 'plus');
});

test('ended, deleted and user-level purchases do not unlock a server', () => {
  const b = new Billing(new Store(':memory:'), { skuPro: 'sku-pro' });
  b.upsert(ent('e1', 'sku-pro', 'g1', { endsAt: new Date(Date.now() - 1000) }));
  b.upsert(ent('e2', 'sku-pro', 'g2', { deleted: true }));
  b.upsert(ent('e3', 'sku-pro', null));
  b.upsert(ent('e4', 'other-sku', 'g3'));
  for (const g of ['g1', 'g2', 'g3']) assert.equal(b.planOf(g).id, 'free', g);
  // a subscription that ends later is active until then
  b.upsert(ent('e5', 'sku-pro', 'g4', { endsAt: new Date(Date.now() + 86400_000) }));
  assert.equal(b.planOf('g4').id, 'pro');
  assert.equal(b.planOf('g4', Date.now() + 2 * 86400_000).id, 'free');
  // an update that cancels it removes the plan
  b.upsert(ent('e5', 'sku-pro', 'g4', { deleted: true }));
  assert.equal(b.planOf('g4').id, 'free');
});

test('usage counts per server and month, survives a flush, and limits the plan', () => {
  const store = new Store(':memory:');
  const b = new Billing(store, { skuPlus: 'sku-plus', hours: { free: 1 } });
  b.addUsage('g1', 30 * 60_000);
  assert.equal(Math.round(b.usedSeconds('g1')), 1800);
  b.flush();
  b.addUsage('g1', 15 * 60_000);
  assert.equal(Math.round(b.usedSeconds('g1')), 2700);
  assert.equal(Math.round(b.remainingSeconds('g1')), 900);
  b.addUsage('g1', 60 * 60_000);
  assert.equal(b.remainingSeconds('g1'), 0);
  assert.equal(b.usedSeconds('g2'), 0);
  // a new instance (restart) reads what was saved
  b.flush();
  const again = new Billing(store, { skuPlus: 'sku-plus', hours: { free: 1 } });
  assert.equal(Math.round(again.usedSeconds('g1')), 6300);
  // next month starts fresh
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1);
  assert.equal(again.usedSeconds('g1', next), 0);
  // upgrading lifts the cap right away
  again.upsert(ent('e1', 'sku-plus', 'g1'));
  assert.ok(again.remainingSeconds('g1') > 20 * 3600);
});

test('players are told whether to speak translations themselves', () => {
  const hub = new WebHub();
  const b = new Billing(new Store(':memory:'), { skuPro: 'sku-pro' });
  hub.voiceMode = (g) => (b.planOf(g).aiVoice ? 'ai' : 'device');
  const sent: Record<string, unknown>[] = [];
  const sock = { send: (d: string | Buffer) => { if (typeof d === 'string') sent.push(JSON.parse(d)); }, readyState: 1, bufferedAmount: 0, close() {} };
  hub.attach('g1', 'u1', 'en', sock as never);
  assert.equal(sent.at(-1)?.voice, 'device');
  b.upsert(ent('e1', 'sku-pro', 'g1'));
  hub.attach('g1', 'u2', 'en', sock as never);
  assert.equal(sent.at(-1)?.voice, 'ai');
});

test('hours read naturally', () => {
  assert.equal(formatHours(Infinity), 'unlimited');
  assert.equal(formatHours(59), '0 min');
  assert.equal(formatHours(45 * 60), '45 min');
  assert.equal(formatHours(3 * 3600), '3 h');
  assert.equal(formatHours(3 * 3600 + 20 * 60), '3 h 20 min');
});

/**
 * Sharded launch (needed beyond ~2,500 guilds). Each shard is a separate
 * process with its own worker connections and web port (WEB_PORT + shardId).
 * Put a reverse proxy in front that routes /listen links per shard, or keep a
 * single shard and scale workers instead (voice load lives in the workers).
 */

import { ShardingManager } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is required');

const manager = new ShardingManager(join(here, 'main.js'), {
  token,
  totalShards: process.env.SHARD_COUNT ? Number(process.env.SHARD_COUNT) : 'auto',
  respawn: true,
});
manager.on('shardCreate', (s) => console.log(JSON.stringify({ level: 'info', msg: 'shard launched', shard: s.id })));
void manager.spawn({ timeout: 60_000 });

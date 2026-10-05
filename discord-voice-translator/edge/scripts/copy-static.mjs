// Copies web/static/*.html into dist after `tsc`.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist/web/static'), { recursive: true });
cpSync(join(root, 'src/web/static'), join(root, 'dist/web/static'), { recursive: true });
console.log('static files copied');

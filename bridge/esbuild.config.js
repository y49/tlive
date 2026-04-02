import { build } from 'esbuild';

const isWatch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [
    '@anthropic-ai/*',
    'discord.js',
    'grammy',
    '@grammyjs/*',
    '@larksuiteoapi/*',
    'node-telegram-bot-api',
  ],
  sourcemap: true,
  ...(isWatch ? { watch: true } : {}),
};

await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.mjs' }),
  build({ ...common, entryPoints: ['src/setup-wizard.ts'], outfile: 'dist/setup.mjs' }),
]);

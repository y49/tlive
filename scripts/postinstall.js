#!/usr/bin/env node
// postinstall: download Go Core binary + copy hook scripts to ~/.tlive/bin/
import { createWriteStream, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, arch } from 'node:os';
import { get } from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_REPO = 'y49/tlive';
const BIN_DIR = join(homedir(), '.tlive', 'bin');
const VERSION_FILE = join(BIN_DIR, '.core-version');

const PLATFORM_MAP = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64' };

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return `v${pkg.version}`;
  } catch {
    return 'latest';
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      let lastPercent = -1;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const percent = Math.floor(downloaded / total * 100);
          if (percent !== lastPercent && percent % 5 === 0) {
            lastPercent = percent;
            const mb = (downloaded / 1048576).toFixed(1);
            const totalMb = (total / 1048576).toFixed(1);
            const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
            process.stdout.write(`\r  ${bar} ${percent}% (${mb}/${totalMb} MB)`);
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        if (total > 0) process.stdout.write('\n');
        file.close();
        resolve();
      });
    }).on('error', reject);
  });
}


function copyReferenceDocs() {
  const docsDir = join(homedir(), '.tlive', 'docs');
  mkdirSync(docsDir, { recursive: true });

  const refsDir = join(__dirname, '..', 'references');
  const docs = ['setup-guides.md', 'token-validation.md', 'troubleshooting.md'];
  for (const doc of docs) {
    const src = join(refsDir, doc);
    const dest = join(docsDir, doc);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  // Copy config template so the skill can reference exact variable names
  const configExample = join(__dirname, '..', 'config.env.example');
  const configDest = join(docsDir, 'config.env.example');
  if (existsSync(configExample)) {
    copyFileSync(configExample, configDest);
  }

  console.log(`Reference docs installed to ${docsDir}`);
}

async function downloadGoBinary() {
  const os = PLATFORM_MAP[platform()];
  const cpu = ARCH_MAP[arch()];

  if (!os || !cpu) {
    console.error(`Unsupported platform: ${platform()}-${arch()}.`);
    console.error('You can build from source: cd core && go build -o tlive-core ./cmd/tlive/');
    console.error(`Then copy the binary to ${BIN_DIR}/tlive-core`);
    process.exit(1);
  }

  const ext = os === 'windows' ? '.exe' : '';
  const binaryName = `tlive-core${ext}`;
  const dest = join(BIN_DIR, binaryName);

  const version = getVersion();

  if (existsSync(dest)) {
    if (statSync(dest).size > 0) {
      // Check if existing binary matches current package version
      try {
        const installed = readFileSync(VERSION_FILE, 'utf-8').trim();
        if (installed === version) {
          console.log(`tlive-core ${version} already installed at ${dest}`);
          return;
        }
        console.log(`Upgrading tlive-core from ${installed} to ${version}...`);
      } catch {
        // No version file — legacy install, re-download
      }
      unlinkSync(dest);
    } else {
      // Remove empty/corrupt file from failed download
      unlinkSync(dest);
    }
  }

  mkdirSync(BIN_DIR, { recursive: true });
  const url = `https://github.com/${GITHUB_REPO}/releases/download/${version}/tlive-${os}-${cpu}${ext}`;

  console.log(`Downloading tlive-core for ${os}-${cpu}...`);

  try {
    await download(url, dest);
    if (os !== 'windows') {
      chmodSync(dest, 0o755);
    }
    writeFileSync(VERSION_FILE, version);
    console.log(`tlive-core ${version} installed to ${dest}`);
  } catch (err) {
    // Clean up empty/partial file from failed download
    try { if (existsSync(dest)) unlinkSync(dest); } catch {}
    console.error(`Failed to download tlive-core: ${err.message}`);
    console.error('You can build from source: cd core && go build -o tlive-core ./cmd/tlive/');
    console.error(`Then copy the binary to ${dest}`);
    process.exit(1);
  }
}

async function main() {
  console.log('Setting up TLive...');
  copyReferenceDocs();
  await downloadGoBinary();
  console.log('\nTLive setup complete.');
  console.log('Next steps:');
  console.log('  1. tlive setup              — configure IM platforms');
  console.log('  2. tlive install skills      — integrate with Claude Code');
}

main().catch(console.error);

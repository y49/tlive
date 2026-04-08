// scripts/postinstall.js
const { version } = process;
const major = parseInt(version.slice(1));
if (major < 20) {
  console.error(`\x1b[31mtlive requires Node.js >= 20 (found ${version})\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32m✓ tlive installed successfully\x1b[0m');

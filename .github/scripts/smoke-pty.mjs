// Loads node-pty from a globally installed tlive and spawns a real ConPTY.
//
// A prebuilt binary that resolves can still fail to load, and one that loads
// can still fail to spawn. Only a real install on a real Windows runner sees
// this; the unit-test job installs from the workspace with a full toolchain.

import { createRequire } from 'node:module';
import { join } from 'node:path';

const globalRoot = process.env.TLIVE_GLOBAL_ROOT;
if (!globalRoot) {
  console.error('TLIVE_GLOBAL_ROOT is not set');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const ptyPath = require.resolve('node-pty', { paths: [join(globalRoot, 'tlive')] });
const { spawn } = require(ptyPath);

const p = spawn('cmd.exe', ['/c', 'echo pty-ok'], { cols: 80, rows: 24 });
let out = '';
p.onData((d) => { out += d; });

setTimeout(() => {
  if (!out.includes('pty-ok')) {
    console.error('pty produced no output; got: ' + JSON.stringify(out));
    process.exit(1);
  }
  console.log('pty loads and runs');
  process.exit(0);
}, 5000);

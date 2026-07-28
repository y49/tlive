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
let done = false;

// 5s is a failure deadline, not a fixed wait: resolve as soon as the output
// arrives so a passing run doesn't burn 5s of runner time, while a ConPTY
// that never answers still fails instead of hanging the job.
const deadline = setTimeout(() => {
  if (done) return;
  done = true;
  console.error('pty produced no output; got: ' + JSON.stringify(out));
  process.exit(1);
}, 5000);

p.onData((d) => {
  out += d;
  if (!done && out.includes('pty-ok')) {
    done = true;
    clearTimeout(deadline);
    console.log('pty loads and runs');
    process.exit(0);
  }
});

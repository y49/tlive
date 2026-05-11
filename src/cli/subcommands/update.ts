// src/cli/subcommands/update.ts
import { spawn } from 'node:child_process';

export async function runUpdate(_argv: string[]): Promise<void> {
  const child = spawn('npm', ['install', '-g', 'tlive@latest'], { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm exited with ${code}`)));
    child.on('error', reject);
  });
}

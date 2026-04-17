import { spawn, execFile as nodeExecFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { LLMProvider, StreamChatParams, StreamChatResult, ProviderCapabilities } from '../base.js';
import { flavorCapabilities } from '../../flavors.js';

const execFileAsync = promisify(nodeExecFile);
const MIN_CODEX_VERSION = '0.121.0';

type ExecFileFn = typeof execFileAsync;

// Module-level cache — isAvailable() result stable for process lifetime
let _availabilityCache: Promise<boolean> | null = null;

/** Test-only: reset the module-level availability cache. */
export function __testing_resetBinaryDetectCache(): void {
  _availabilityCache = null;
}

interface ProviderDeps {
  execFile?: ExecFileFn;
}

export class CodexAppServerProvider implements LLMProvider {
  private execFile: ExecFileFn;

  constructor(deps: ProviderDeps = {}) {
    this.execFile = deps.execFile ?? (execFileAsync as ExecFileFn);
  }

  async isAvailable(): Promise<boolean> {
    if (_availabilityCache) return _availabilityCache;
    _availabilityCache = this.detectCodexBinary();
    return _availabilityCache;
  }

  capabilities(): ProviderCapabilities {
    return flavorCapabilities('codex');
  }

  streamChat(_params: StreamChatParams): StreamChatResult {
    // Full implementation in Task 10
    throw new Error('CodexAppServerProvider.streamChat not yet implemented');
  }

  private async detectCodexBinary(): Promise<boolean> {
    try {
      const { stdout } = await this.execFile('codex', ['--version']);
      const match = stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
      if (!match) return false;
      return compareVersions(match[1], MIN_CODEX_VERSION) >= 0;
    } catch {
      return false;
    }
  }
}

/** Compare two dotted version strings. Returns -1 | 0 | 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Spawn the codex app-server subprocess. */
export function spawnCodexAppServer(): ChildProcess {
  return spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

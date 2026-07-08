// src/kernel/integrations/codex-trust.ts
//
// 只读启发式:判断 tlive 装的 Codex hook 是否已被信任。Codex 把 trust 存在
// ~/.codex/config.toml 的 [hooks.state."<hooks.json路径>:<event>:<i>:<j>"] 下的
// trusted_hash。我们不解析 TOML、不复刻其哈希(避免耦合 Codex 内部),只做文本
// 启发:config 里是否存在同时引用本 hooks.json 路径且带 trusted_hash 的 state 段。

export function codexHookState(opts: {
  hooksJsonExists: boolean;
  configTomlText: string | null;
  hooksJsonPath: string;
}): 'not-installed' | 'installed-untrusted' | 'installed-trusted' {
  if (!opts.hooksJsonExists) return 'not-installed';
  const t = opts.configTomlText ?? '';
  // 找引用本 hooks.json 路径的 [hooks.state."...<path>..."] 段,且其后有 trusted_hash。
  const lines = t.split('\n');
  let inRefState = false;
  for (const line of lines) {
    const sect = line.match(/^\s*\[hooks\.state\.(".*?"|[^\]]+)\]\s*$/);
    if (sect) { inRefState = line.includes(opts.hooksJsonPath); continue; }
    if (inRefState && /^\s*trusted_hash\s*=/.test(line) && !/=\s*("")\s*$/.test(line)) {
      return 'installed-trusted';
    }
  }
  return 'installed-untrusted';
}

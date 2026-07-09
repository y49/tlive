// src/kernel/integrations/codex-trust.ts
//
// 只读启发式:判断 tlive 装的 Codex hook 是否已被信任。Codex 把 trust 存在
// ~/.codex/config.toml 的 [hooks.state."<key>"] 下的 trusted_hash。key 有两代:
//  - 直写时代:<hooks.json 绝对路径>:<event>:<i>:<j>
//  - 插件时代(源码 plugin_hook_key_source):<plugin>@<marketplace>:<相对路径>:<event>:<i>:<j>
//    —— 不含任何绝对路径,且与插件版本无关。
// 我们不解析 TOML、不复刻其哈希(避免耦合 Codex 内部),只做文本启发:
// config 里是否存在引用本 hooks.json 路径 或 tlive 插件 key 的 state 段带 trusted_hash。

const PLUGIN_KEY_PREFIX = 'tlive@tlive:';

export function codexHookState(opts: {
  hooksJsonExists: boolean;
  configTomlText: string | null;
  hooksJsonPath: string;
}): 'not-installed' | 'installed-untrusted' | 'installed-trusted' {
  if (!opts.hooksJsonExists) return 'not-installed';
  const t = opts.configTomlText ?? '';
  const lines = t.split('\n');
  let inRefState = false;
  for (const line of lines) {
    // 任何 section header(以 [ 开头、] 结尾)都重置作用域;仅当它是引用本
    // hooks.json 路径或 tlive 插件 key 的 [hooks.state."…"] 段才进入受信段。
    if (/^\s*\[/.test(line) && /\]\s*$/.test(line)) {
      inRefState = line.includes('[hooks.state.')
        && (line.includes(opts.hooksJsonPath) || line.includes(`"${PLUGIN_KEY_PREFIX}`));
      continue;
    }
    if (inRefState && /^\s*trusted_hash\s*=/.test(line) && !/=\s*""\s*$/.test(line)) {
      return 'installed-trusted';
    }
  }
  return 'installed-untrusted';
}

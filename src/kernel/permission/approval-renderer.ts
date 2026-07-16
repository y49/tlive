// src/kernel/permission/approval-renderer.ts
//
// Vendor-neutral approval-card renderer. Pure function: normalized request →
// { title, body } markdown-ish text destined for OutgoingMessage.card.body
// (does NOT touch the frozen im-adapter contract). Renders diffs/commands,
// flags risky shell patterns, masks secrets. Shared by IM (M5) and web (M6).
// MUST NOT reference any CC/Codex-specific field or path.
//
// Secret masking covers key=value / URL params / Bearer headers / JSON secret-values.
// Sensitive-path flagging (.env/.ssh/*.key) and high-entropy long-string masking are
// deliberately out of scope (trusted-user audience).

export interface RenderRequest {
  toolName: string;
  input: unknown;
}

/** Mask secret-looking substrings. Best-effort; conservative patterns only. */
export function maskSecrets(s: string): string {
  return s
    .replace(/([?&][\w-]*(?:token|key|auth|password|secret)[\w-]*=)[^&\s]+/gi, '$1***')
    // env/CLI assignment, case-insensitive; value stops at whitespace or & so it
    // neither swallows a following URL param nor re-masks an already-masked value.
    .replace(/\b([\w-]*(?:token|key|secret|password|passwd|apikey|auth)[\w-]*\s*=\s*)[^\s&]+/gi, '$1***')
    .replace(/\b(Bearer\s+)\S+/gi, '$1***')
    .replace(/("(?:\w*(?:token|key|secret|password|auth)\w*)"\s*:\s*")[^"]+/gi, '$1***');
}

const RISKY: Array<{ re: RegExp; name: string }> = [
  { re: /\brm\s+-[rf]/, name: 'rm -rf' },
  { re: /\bsudo\b/, name: 'sudo' },
  { re: /\bcurl\b[^\n]*\|\s*(?:sh|bash)/, name: 'curl | sh' },
  { re: /\bwget\b[^\n]*\|\s*(?:sh|bash)/, name: 'wget | sh' },
  { re: /:\(\)\s*\{/, name: 'fork bomb' },
  { re: /\bmkfs\b/, name: 'mkfs' },
  { re: /\bdd\s+if=/, name: 'dd' },
  { re: /\bchmod\s+(?:-R\s+)?[0-7]*7{2,}/, name: 'chmod 777' },
  { re: /authorized_keys/, name: 'authorized_keys' },
  { re: /\bgit\s+push\b[^\n]*(?:--force|-f)\b/, name: 'git push --force' },
  { re: /\beval\b/, name: 'eval' },
  { re: />\s*\/dev\/sd/, name: 'write to disk' },
];

/** 命中的高危模式点名(而非笼统"risky"),让审批者一眼看到危险在哪。 */
function riskFlag(command: string): string {
  const hits = RISKY.filter((r) => r.re.test(command)).map((r) => r.name);
  return hits.length ? `\n⚠️ **Risky** — ${hits.join(', ')}` : '';
}

/** Break triple-backtick runs so agent-controlled content can't close or forge
 *  a Markdown code fence (approval-card spoofing: hide the real command behind
 *  a fake fence). Zero-width joiner keeps it visually intact. */
function fenceSafe(s: string): string {
  return s.replace(/```/g, '`​``');
}
/** Neutralize backticks for an inline `code` span (a stray one breaks out). */
function inlineSafe(s: string): string {
  return s.replace(/`/g, "'");
}

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function renderApprovalCard(req: RenderRequest): { title: string; body: string } {
  const { toolName, input } = req;
  const title = toolName;
  switch (toolName) {
    case 'Edit': {
      const fp = inlineSafe(str(input, 'file_path') ?? '(unknown)');
      const oldS = maskSecrets(str(input, 'old_string') ?? '');
      const newS = maskSecrets(str(input, 'new_string') ?? '');
      const diff = fenceSafe([
        ...oldS.split('\n').map((l) => `- ${l}`),
        ...newS.split('\n').map((l) => `+ ${l}`),
      ].join('\n')).slice(0, 1500);
      return { title, body: `\`${fp}\`\n\`\`\`diff\n${diff}\n\`\`\`` };
    }
    case 'Write': {
      const fp = inlineSafe(str(input, 'file_path') ?? '(unknown)');
      const content = fenceSafe(maskSecrets(str(input, 'content') ?? '')).slice(0, 800);
      return { title, body: `Write to \`${fp}\`\n\`\`\`\n${content}\n\`\`\`` };
    }
    case 'NotebookEdit': {
      const fp = inlineSafe(str(input, 'notebook_path') ?? '(unknown)');
      const src = fenceSafe(maskSecrets(str(input, 'new_source') ?? '')).slice(0, 800);
      return { title, body: `Notebook \`${fp}\`\n\`\`\`\n${src}\n\`\`\`` };
    }
    case 'Bash': {
      const cmd = str(input, 'command') ?? '';
      const desc = str(input, 'description');
      // 描述斜体、与命令块空一行分层;命中的高危模式点名列出
      return { title, body: `${desc ? `*${inlineSafe(desc)}*\n\n` : ''}\`\`\`bash\n${fenceSafe(maskSecrets(cmd))}\n\`\`\`${riskFlag(cmd)}` };
    }
    case 'apply_patch': {
      const patch = fenceSafe(maskSecrets(str(input, 'command') ?? '')).slice(0, 1500);
      return { title, body: `\`\`\`diff\n${patch}\n\`\`\`` };
    }
    default: {
      // 未知/MCP 工具:键值摘要比裸 JSON 可读得多;值截断,防长文淹没卡片
      const obj = (input ?? {}) as Record<string, unknown>;
      const secretKey = /token|key|secret|password|passwd|auth/i;
      const lines = Object.entries(obj)
        .slice(0, 8)
        .map(([k, v]) => {
          const raw = typeof v === 'string' ? v : JSON.stringify(v);
          // 键名即敏感 → 整值打码(maskSecrets 只认 k=v/JSON 形态,盖不住裸值)
          const val = secretKey.test(k) ? '***' : inlineSafe(maskSecrets(raw ?? '')).slice(0, 120);
          return `${inlineSafe(k)}: ${val}`;
        });
      const body = lines.length ? fenceSafe(lines.join('\n')).slice(0, 500) : '(no input)';
      return { title, body: `\`\`\`\n${body}\n\`\`\`` };
    }
  }
}

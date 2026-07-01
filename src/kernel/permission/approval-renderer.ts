// src/kernel/permission/approval-renderer.ts
//
// Vendor-neutral approval-card renderer. Pure function: normalized request →
// { title, body } markdown-ish text destined for OutgoingMessage.card.body
// (does NOT touch the frozen im-adapter contract). Renders diffs/commands,
// flags risky shell patterns, masks secrets. Shared by IM (M5) and web (M6).
// MUST NOT reference any CC/Codex-specific field or path.

export interface RenderRequest {
  toolName: string;
  input: unknown;
}

/** Mask secret-looking substrings. Best-effort; conservative patterns only. */
export function maskSecrets(s: string): string {
  return s
    .replace(/([?&][\w-]*(?:token|key|auth|password|secret)[\w-]*=)[^&\s]+/gi, '$1***')
    .replace(/\b([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*=)\S+/g, '$1***');
}

const RISKY = [/\brm\s+-[rf]/, /\bsudo\b/, /\bcurl\b[^\n]*\|\s*(?:sh|bash)/, /:\(\)\s*\{/, /\bmkfs\b/, /\bdd\s+if=/];

function riskFlag(command: string): string {
  return RISKY.some((re) => re.test(command)) ? '\n⚠️ **高危命令**' : '';
}

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function renderApprovalCard(req: RenderRequest): { title: string; body: string } {
  const { toolName, input } = req;
  const title = `权限请求: ${toolName}`;
  switch (toolName) {
    case 'Edit': {
      const fp = str(input, 'file_path') ?? '(unknown)';
      const oldS = maskSecrets(str(input, 'old_string') ?? '');
      const newS = maskSecrets(str(input, 'new_string') ?? '');
      const diff = [
        ...oldS.split('\n').map((l) => `- ${l}`),
        ...newS.split('\n').map((l) => `+ ${l}`),
      ].join('\n');
      return { title, body: `\`${fp}\`\n\`\`\`diff\n${diff}\n\`\`\`` };
    }
    case 'Write': {
      const fp = str(input, 'file_path') ?? '(unknown)';
      const content = maskSecrets(str(input, 'content') ?? '').slice(0, 800);
      return { title, body: `写入 \`${fp}\`\n\`\`\`\n${content}\n\`\`\`` };
    }
    case 'NotebookEdit': {
      const fp = str(input, 'notebook_path') ?? '(unknown)';
      const src = maskSecrets(str(input, 'new_source') ?? '').slice(0, 800);
      return { title, body: `Notebook \`${fp}\`\n\`\`\`\n${src}\n\`\`\`` };
    }
    case 'Bash': {
      const cmd = str(input, 'command') ?? '';
      const desc = str(input, 'description');
      return { title, body: `${desc ? desc + '\n' : ''}\`\`\`bash\n${maskSecrets(cmd)}\n\`\`\`${riskFlag(cmd)}` };
    }
    default: {
      const json = maskSecrets(JSON.stringify(input ?? {})).slice(0, 500);
      return { title, body: `\`\`\`json\n${json}\n\`\`\`` };
    }
  }
}

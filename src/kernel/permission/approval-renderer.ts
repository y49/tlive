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

import { riskHits } from './risk.js';

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

/** 命中的高危模式点名(而非笼统"risky"),让审批者一眼看到危险在哪。
 *  模式清单在 risk.ts —— 与 PolicyEngine 的 never-auto-allow 守卫共用一份,
 *  确保"卡上标红的"和"任何模式都拒绝自动放行的"永远是同一个集合。 */
function riskFlag(command: string): string {
  const hits = riskHits(command);
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
      return { title, body: `\n\`${fp}\`\n\n\`\`\`diff\n${diff}\n\`\`\`` };
    }
    case 'Write': {
      const fp = inlineSafe(str(input, 'file_path') ?? '(unknown)');
      const content = fenceSafe(maskSecrets(str(input, 'content') ?? '')).slice(0, 800);
      return { title, body: `\nWrite to \`${fp}\`\n\n\`\`\`\n${content}\n\`\`\`` };
    }
    case 'NotebookEdit': {
      const fp = inlineSafe(str(input, 'notebook_path') ?? '(unknown)');
      const src = fenceSafe(maskSecrets(str(input, 'new_source') ?? '')).slice(0, 800);
      return { title, body: `\nNotebook \`${fp}\`\n\n\`\`\`\n${src}\n\`\`\`` };
    }
    case 'Bash': {
      const cmd = str(input, 'command') ?? '';
      // Codex commandExecution approvals carry `reason` (not `description`) —
      // fall back to it so the command's rationale shows on the card. CC's Bash
      // input has no `reason`, so this only ever fires for Codex.
      const desc = str(input, 'description') ?? str(input, 'reason');
      // B 全留白:标题后空行(前导 \n) + 描述后空行 + 风险行空开。
      // 无 desc 时前导 \n\n(否则单 \n 被 fence 前 trim 吃掉,标题后无空行)。
      return { title, body: `${desc ? `\n*${inlineSafe(desc)}*\n\n` : '\n\n'}\`\`\`bash\n${fenceSafe(maskSecrets(cmd))}\n\`\`\`${riskFlag(cmd)}` };
    }
    case 'apply_patch': {
      const patch = fenceSafe(maskSecrets(str(input, 'command') ?? '')).slice(0, 1500);
      return { title, body: `\n\n\`\`\`diff\n${patch}\n\`\`\`` };
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
      return { title, body: `\n\n\`\`\`\n${body}\n\`\`\`` };
    }
  }
}

/** One line naming what a tool call actually is, for a desktop notification.
 *  Deliberately NOT renderApprovalCard: that builds markdown with diff fences
 *  for an IM card, while a desktop body is clipped to about two lines by the
 *  notification server. So this carries the SHAPE of the call — tool plus one
 *  target — never its payload.
 *
 *  No masking and no truncation here on purpose: renderWaiting applies both to
 *  every notice body it renders, whatever the source, so a future detail
 *  source cannot forget them. */
export function summarizeToolCall(toolName: string, input: unknown): string {
  const one = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const base = (p: string): string => one(p).split(/[\\/]/).pop() ?? '';
  const target = ((): string => {
    switch (toolName) {
      case 'Bash': return one(str(input, 'command') ?? '');
      case 'Edit': case 'Write': case 'Read': return base(str(input, 'file_path') ?? '');
      case 'NotebookEdit': return base(str(input, 'notebook_path') ?? '');
      case 'Glob': case 'Grep': return one(str(input, 'pattern') ?? '');
      case 'apply_patch': {
        const m = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(str(input, 'command') ?? '');
        return m ? base(m[1]!) : '';
      }
      case 'WebFetch': {
        const u = one(str(input, 'url') ?? '');
        try { return new URL(u).host; } catch { return u; }
      }
      case 'Task': return one(str(input, 'description') ?? '');
      case 'AskUserQuestion': {
        // The header exists to be a short label — it is what the question is
        // ABOUT, which is exactly the one line wanted here. Without one, the
        // question text itself; the renderer caps the length either way.
        const q = (input as { questions?: Array<{ question?: string; header?: string }> } | null)?.questions?.[0];
        return one(q?.header ?? q?.question ?? '');
      }
      default: return '';
    }
  })();
  return target ? `${toolName} · ${target}` : toolName;
}

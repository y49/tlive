# KERNEL.md — tlive frozen surface

> **WARNING**: This file documents the frozen API surface of tlive 1.0.
> Modifying any interface listed here is a breaking change requiring a major version bump.
> See `docs/superpowers/specs/2026-05-11-tlive-kernel-redesign-design.md` for design rationale.
>
> **This file is a STUB during Phase 0. Phase 9 fills it in fully.**

## Frozen Surfaces

- IMAdapter interface — see `src/kernel/contracts/im-adapter.ts`
- RuntimeAdapter interface — see `src/kernel/contracts/runtime-adapter.ts`
- IncomingEnvelope / OutgoingMessage — see `src/kernel/contracts/im-adapter.ts`
- RuntimeEvent — see `src/kernel/contracts/runtime-event.ts`
- MCP tool surface (3 tools) — see `src/kernel/contracts/mcp-tools.ts`
- CLI subcommand surface — see `src/kernel/contracts/cli-surface.ts`

(Full content TBD in Phase 9.)

# Transport library decision (Task 1 spike result)

**Decision:** Hand-roll transport + client (Option B).

**Reason:** vscode-jsonrpc always emits LSP `Content-Length:` framing and
auto-injects `"jsonrpc":"2.0"` on every message. Its `StreamMessageReader`
silently ignores JSONL input (newline-delimited JSON without a Content-Length
header) — confirmed empirically: injecting a raw `{"id":1,"method":...}\n`
produced zero response from a listening server. codex-app-server emits plain
JSONL and omits the `"jsonrpc":"2.0"` field, so the framing layers are
fundamentally incompatible. Wrapping vscode-jsonrpc would require replacing
both the reader and writer, eliminating any benefit from the library.

**Impact:** transport.ts ~120 LOC, client.ts ~220 LOC instead of ~50/~80.
All subsequent tasks proceed with hand-rolled implementation.

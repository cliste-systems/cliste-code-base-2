/** Staff-facing transcript cleanup — hide internal tool RPC from readable conversation. */

const TOOL_BLOCK_RE = /^\[Tool/i;

/** Remove [Tool], [Tool result], and [Tool error] blocks from a stored transcript. */
export function stripToolLinesFromTranscript(text: string | null | undefined): string {
  const raw = String(text ?? '').trim();
  if (!raw) return '';

  return raw
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !TOOL_BLOCK_RE.test(block))
    .join('\n\n')
    .trim();
}

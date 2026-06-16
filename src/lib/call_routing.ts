export const CALL_ROUTING_MODES = [
  'cliste_number',
  'forward_all',
  'forward_missed',
] as const;

export type CallRoutingMode = (typeof CALL_ROUTING_MODES)[number];

export function parseCallRoutingMode(raw: unknown): CallRoutingMode {
  if (
    typeof raw === 'string' &&
    (CALL_ROUTING_MODES as readonly string[]).includes(raw)
  ) {
    return raw as CallRoutingMode;
  }
  return 'cliste_number';
}

export function callRoutingAllowsHumanTransfer(mode: CallRoutingMode): boolean {
  return mode === 'cliste_number';
}

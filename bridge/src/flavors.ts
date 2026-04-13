export const Flavors = ['claude', 'codex'] as const;
export type Flavor = typeof Flavors[number];

export const Capabilities = {
  ModelChange: 'model-change',
  Effort: 'effort',
  LiveSession: 'live-session',
  AskUserQuestion: 'ask-user-question',
  TodoTracking: 'todo-tracking',
  CostInUsd: 'cost-in-usd',
  Skills: 'skills',
  SessionResume: 'session-resume',
  SlashCommands: 'slash-commands',
} as const;

export type Capability = typeof Capabilities[keyof typeof Capabilities];

const FLAVOR_CAPS: Record<Flavor, ReadonlySet<Capability>> = {
  claude: new Set<Capability>([
    Capabilities.ModelChange,
    Capabilities.Effort,
    Capabilities.LiveSession,
    Capabilities.AskUserQuestion,
    Capabilities.TodoTracking,
    Capabilities.CostInUsd,
    Capabilities.Skills,
    Capabilities.SessionResume,
    Capabilities.SlashCommands,
  ]),
  codex: new Set<Capability>([
    Capabilities.ModelChange,
    Capabilities.Effort,
    Capabilities.SessionResume,
  ]),
};

const FLAVOR_LABELS: Record<Flavor, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export function isKnownFlavor(value: string | null | undefined): value is Flavor {
  return typeof value === 'string' && (Flavors as readonly string[]).includes(value);
}

export function hasCapability(flavor: string | null | undefined, cap: Capability): boolean {
  if (!isKnownFlavor(flavor)) return false;
  return FLAVOR_CAPS[flavor].has(cap);
}

export function getFlavorLabel(flavor: string | null | undefined): string {
  if (!isKnownFlavor(flavor)) return 'Unknown';
  return FLAVOR_LABELS[flavor];
}

export function supportsModelChange(flavor: string | null | undefined): boolean {
  return hasCapability(flavor, Capabilities.ModelChange);
}
export function supportsEffort(flavor: string | null | undefined): boolean {
  return hasCapability(flavor, Capabilities.Effort);
}
export function supportsLiveSession(flavor: string | null | undefined): boolean {
  return hasCapability(flavor, Capabilities.LiveSession);
}

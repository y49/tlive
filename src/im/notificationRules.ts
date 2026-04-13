export type NotificationKind =
  | 'permission_request'
  | 'ask_user_question'
  | 'error'
  | 'session_complete'
  | 'todo_update'
  | 'thinking'
  | 'activity_text'
  | 'activity_tool';

interface NotificationRule {
  alwaysPush: boolean;
  aggregate: boolean;
  maxTextLength: number;
}

const RULES: Record<NotificationKind, NotificationRule> = {
  permission_request:  { alwaysPush: true,  aggregate: false, maxTextLength: 500 },
  ask_user_question:   { alwaysPush: true,  aggregate: false, maxTextLength: 500 },
  error:               { alwaysPush: true,  aggregate: false, maxTextLength: 300 },
  session_complete:    { alwaysPush: true,  aggregate: false, maxTextLength: 100 },
  todo_update:         { alwaysPush: true,  aggregate: false, maxTextLength: 500 },
  thinking:            { alwaysPush: false, aggregate: true,  maxTextLength: 50 },
  activity_text:       { alwaysPush: true,  aggregate: false, maxTextLength: 300 },
  activity_tool:       { alwaysPush: false, aggregate: true,  maxTextLength: 500 },
};

export function getRule(kind: NotificationKind): NotificationRule {
  return RULES[kind];
}

export function shouldPush(kind: NotificationKind, isUserActive: boolean): boolean {
  const rule = RULES[kind];
  return rule.alwaysPush || !isUserActive;
}

export function shouldAggregate(kind: NotificationKind): boolean {
  return RULES[kind].aggregate;
}

export function getMaxTextLength(kind: NotificationKind): number {
  return RULES[kind].maxTextLength;
}

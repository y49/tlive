export type NotificationKind =
  | 'permission_request' | 'ask_user_question' | 'session_complete' | 'error' | 'todo_update'
  | 'reasoning_summary' | 'file_change_list' | 'activity_text'
  | 'activity_tool' | 'thinking';

export type VerboseLevel = 0 | 1 | 2;

const TIER: Record<NotificationKind, 0 | 1 | 2> = {
  permission_request: 0, ask_user_question: 0, session_complete: 0, error: 0, todo_update: 0,
  reasoning_summary: 1, file_change_list: 1, activity_text: 1,
  activity_tool: 2, thinking: 2,
};

export function shouldPushAtLevel(kind: NotificationKind, level: VerboseLevel): boolean {
  return TIER[kind] <= level;
}

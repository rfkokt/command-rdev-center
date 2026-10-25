/**
 * Cross-session search → "open the chat and scroll to the match"
 * (docs/tasks/orca-essentials O2-02). The target chat may not be mounted yet
 * (or its history still loading), so a request waits here until that chat
 * takes it; mounted chats also get a window event.
 */
const pending = new Map<string, string>();
export const REVEAL_EVENT = "kern-reveal-message";

export function requestReveal(chatId: string, query: string) {
  pending.set(chatId, query);
  window.dispatchEvent(
    new CustomEvent(REVEAL_EVENT, { detail: { chatId, query } }),
  );
}

export function takeReveal(chatId: string): string | null {
  const query = pending.get(chatId) ?? null;
  pending.delete(chatId);
  return query;
}

/** Index of the first item whose text contains `query` (case-insensitive). */
export function findMatchIndex(
  texts: ReadonlyArray<string | null>,
  query: string,
): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return -1;
  return texts.findIndex(
    (text) => !!text && text.toLowerCase().includes(needle),
  );
}

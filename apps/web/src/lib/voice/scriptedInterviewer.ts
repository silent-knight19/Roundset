export const INITIAL_QUESTION =
  "Welcome to your practice interview. Let's start with Java. Explain the difference between an interface and an abstract class, and when you would choose each.";

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function nextDemoQuestion(answer: string, turnNumber: number): string {
  const words = answer.toLowerCase();
  if (turnNumber === 1 && (words.includes('interface') || words.includes('abstract'))) {
    return 'Thanks. Can you describe a real Java design where using an interface was preferable to extending a base class?';
  }
  if (turnNumber === 2) {
    return 'Good. What happens if two interfaces provide the same default method and one class implements both?';
  }
  if (turnNumber === 3) {
    return 'Now consider concurrency. What is the difference between synchronized and a ReentrantLock in Java?';
  }
  return 'Can you walk me through a concrete example and explain the trade-offs of that choice?';
}

export function safeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-10)
    .filter(
      (item): item is ChatMessage =>
        Boolean(item) &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string',
    )
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, 900),
    }));
}

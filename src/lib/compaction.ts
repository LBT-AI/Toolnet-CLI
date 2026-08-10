export type Role = "user" | "assistant" | "system" | "tool";

export interface Msg {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface CompactionResult {
  compacted: boolean;
  messages: Msg[];
  originalCount: number;
  newCount: number;
  savedChars: number;
  reason?: string;
}

export const DEFAULT_COMPACTION_THRESHOLD_CHARS = 90000; // ~23k tokens (~75% threshold)

export function estimateMessageChars(messages: Msg[]): number {
  let total = 0;
  for (const m of messages) {
    total += (m.content || "").length;
    if (m.name) total += m.name.length;
    if (m.tool_calls) total += JSON.stringify(m.tool_calls).length;
  }
  return total;
}

export function compactMessages(
  messages: Msg[],
  options?: {
    force?: boolean;
    thresholdChars?: number;
    keepRecentCount?: number;
  }
): CompactionResult {
  const force = options?.force ?? false;
  const thresholdChars = options?.thresholdChars ?? DEFAULT_COMPACTION_THRESHOLD_CHARS;
  const keepRecentCount = options?.keepRecentCount ?? 6;

  const totalChars = estimateMessageChars(messages);

  if (!force && totalChars < thresholdChars) {
    return {
      compacted: false,
      messages,
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      reason: `Context size (${totalChars} chars / ~${Math.round(totalChars / 3.8)} tokens) is below auto-compaction threshold (${thresholdChars} chars).`
    };
  }

  if (messages.length <= keepRecentCount + 2) {
    return {
      compacted: false,
      messages,
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      reason: `Not enough messages to compact (${messages.length} messages).`
    };
  }

  const systemMessages: Msg[] = [];
  const middleMessages: Msg[] = [];
  const recentMessages: Msg[] = [];

  const splitIdx = Math.max(0, messages.length - keepRecentCount);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i < splitIdx) {
      if (msg.role === "system" && i < 2) {
        systemMessages.push(msg);
      } else {
        middleMessages.push(msg);
      }
    } else {
      recentMessages.push(msg);
    }
  }

  if (middleMessages.length === 0) {
    return {
      compacted: false,
      messages,
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0
    };
  }

  const userRequests: string[] = [];
  const toolActions: string[] = [];
  const filesTouched = new Set<string>();

  for (const m of middleMessages) {
    if (m.role === "user" && m.content) {
      const firstLine = m.content.split("\n")[0].slice(0, 100);
      userRequests.push(firstLine);
    } else if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.function?.name) {
          toolActions.push(tc.function.name);
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            if (args.path) filesTouched.add(args.path);
            if (args.url) filesTouched.add(args.url);
          } catch {}
        }
      }
    }
  }

  const summaryLines = [
    `[Context Compaction Summary]`,
    `The earlier conversation history (${middleMessages.length} messages) has been compacted to optimize context length.`,
    ``,
    `Key User Requests:`,
    userRequests.length > 0 ? userRequests.map(r => `• ${r}`).slice(-5).join("\n") : "• (general task execution)",
    ``,
    `Tools Used Previously: ${Array.from(new Set(toolActions)).join(", ") || "none"}`,
    `Key Files / Resources Touched: ${Array.from(filesTouched).join(", ") || "none"}`,
    ``,
    `Note: Prior context summary is active above. Continue directly with current user goals.`
  ];

  const summaryMsg: Msg = {
    role: "system",
    content: summaryLines.join("\n")
  };

  const compactedMessages = [...systemMessages, summaryMsg, ...recentMessages];
  const newChars = estimateMessageChars(compactedMessages);
  const savedChars = Math.max(0, totalChars - newChars);

  return {
    compacted: true,
    messages: compactedMessages,
    originalCount: messages.length,
    newCount: compactedMessages.length,
    savedChars
  };
}

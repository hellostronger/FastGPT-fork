import { jsonrepair } from 'jsonrepair';
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall } from '../ai/llm/type';

/**
 * tool call 被剔除的原因：
 * - invalid：arguments 不是字符串，或不是合法 JSON；
 * - not-object：是合法 JSON，但顶层不是普通对象（上游会以 "must be a JSON object" 400）；
 * - truncated：原始串是修复结果的严格前缀，即流式被中断后落库的半截 JSON；
 * - unrepairable：jsonrepair 无法修复，或修复后不是普通对象。
 */
export type DroppedToolCallReason = 'invalid' | 'not-object' | 'truncated' | 'unrepairable';

export type DroppedToolCall = {
  toolCallId: string;
  toolName?: string;
  reason: DroppedToolCallReason;
  argsLength: number;
};

type ToolArgumentsResolution =
  | { keep: true; arguments: string; repaired: boolean }
  | { keep: false; reason: DroppedToolCallReason };

/** 顶层必须是普通对象：null / 数组 / 原始值都不满足上游 `must be a JSON object`。 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 判断 arguments 是否已严格合法：必须是字符串、JSON.parse 成功、且顶层是普通对象。
 */
export const isValidToolArguments = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  try {
    return isPlainObject(JSON.parse(value));
  } catch {
    return false;
  }
};

const parseToolArguments = (
  value: unknown
): { kind: 'valid' } | { kind: 'invalid' } | { kind: 'not-object' } => {
  if (typeof value !== 'string') return { kind: 'invalid' };
  try {
    return isPlainObject(JSON.parse(value)) ? { kind: 'valid' } : { kind: 'not-object' };
  } catch {
    return { kind: 'invalid' };
  }
};

/**
 * 尝试修复「真格式瑕疵」（尾逗号、单引号、未加引号的键等）。
 *
 * 必须同时满足才判定为可修复：
 * 1. jsonrepair 能修复；
 * 2. 修复结果 JSON.parse 成功且顶层是普通对象；
 * 3. 修复结果不以原始串开头 —— 流式中断产生的半截 JSON 的特征就是
 *    「原始串是修复结果的严格前缀」（`{"age": 1` -> `{"age": 1}`），
 *    这类修复只是在给残缺数据补括号/伪造 null，必须排除。
 *
 * 任一条件不满足都返回不可修复原因，由调用方按剔除处理。
 */
const repairFormatGlitch = (
  original: unknown
): { repaired: string } | { reason: 'truncated' | 'unrepairable' } => {
  if (typeof original !== 'string' || !original.trim()) return { reason: 'unrepairable' };

  let repaired: string;
  try {
    repaired = jsonrepair(original);
  } catch {
    return { reason: 'unrepairable' };
  }

  if (parseToolArguments(repaired).kind !== 'valid') return { reason: 'unrepairable' };
  // 截断的稳定特征：原始串是修复结果的严格前缀。
  if (repaired.startsWith(original)) return { reason: 'truncated' };
  // 中断也可能发生在逗号/空白之后（`{"a":1,`）：jsonrepair 会先去掉尾逗号再补括号，
  // 修复结果便不再以原始串开头。这里用「去掉尾部逗号/空白后的前缀」再比一次；
  // 若原串本身已带闭合括号（`{"a":1,}` 这类真尾逗号瑕疵），strippedPrefix 不会变化，仍按可修复处理。
  const strippedPrefix = original.replace(/[\s,]+$/, '');
  if (
    strippedPrefix !== original &&
    strippedPrefix.trim().length > 0 &&
    repaired.startsWith(strippedPrefix)
  ) {
    return { reason: 'truncated' };
  }

  return { repaired };
};

/**
 * 解析单个 tool call 的 arguments，决定「原样保留 / 修复后保留 / 剔除」。
 */
const resolveToolArguments = (value: unknown): ToolArgumentsResolution => {
  if (typeof value !== 'string') return { keep: false, reason: 'invalid' };

  const parsed = parseToolArguments(value);
  if (parsed.kind === 'valid') return { keep: true, arguments: value, repaired: false };
  if (parsed.kind === 'not-object') return { keep: false, reason: 'not-object' };

  const repaired = repairFormatGlitch(value);
  if ('repaired' in repaired) {
    return { keep: true, arguments: repaired.repaired, repaired: true };
  }
  return { keep: false, reason: repaired.reason };
};

/**
 * 归一化 tool call 的 arguments 字符串。
 *
 * - 已合法（JSON.parse 成功且顶层为普通对象）的字符串原样返回，保证字节级稳定（幂等）；
 * - 仅当判定为「真格式瑕疵」（非截断）时返回修复结果；
 * - 其余情况返回 undefined，表示该 tool call 应从回放消息中剔除。
 *
 * 不再伪造空对象：`{}` 会让下游工具以残缺参数执行，且掩盖了调用从未完成的事实。
 */
export const sanitizeToolArguments = (params: unknown): string | undefined => {
  const resolution = resolveToolArguments(params);
  return resolution.keep ? resolution.arguments : undefined;
};

/** 单个内容字段是否「有内容」：非空字符串或非空数组。 */
const hasContentValue = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
};

/** assistant 消息在 tool_calls 被清空后是否仍有保留价值（有文本或推理内容）。 */
const hasAssistantContent = (message: {
  content?: unknown;
  reasoning_content?: unknown;
}): boolean => hasContentValue(message.content) || hasContentValue(message.reasoning_content);

/**
 * 回放前兜底：收敛历史消息里非法的 assistant.tool_calls[].function.arguments。
 *
 * 策略（方案 B + D）：
 * 1. assistant.tool_calls 中，arguments 合法（顶层对象）的原样保留；
 *    真格式瑕疵（尾逗号/单引号/未加引号键等，非截断）修复后保留；
 *    其余整条 call 剔除，并记入 dropped。
 * 2. call 被全部剔除后删除 tool_calls 字段；若该消息既无 content 也无 reasoning_content，
 *    整条消息删除。
 * 3. 删除所有 tool_call_id 命中 dropped 的 role:'tool' 消息，避免出现孤儿 tool 消息。
 *    不做全局孤儿清理：历史 legacy 的配对规则复杂，超出本次范围。
 *
 * 幂等：无需修改时返回原数组引用与原消息对象，合法参数保持字节级不变。
 */
export const reconcileToolCallMessages = <T extends ChatCompletionMessageParam>(
  messages: T[]
): { messages: T[]; dropped: DroppedToolCall[] } => {
  const dropped: DroppedToolCall[] = [];
  if (!Array.isArray(messages) || messages.length === 0) return { messages, dropped };

  const replaced = new Map<number, T | null>();
  const droppedCallIds = new Set<string>();

  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const toolCalls = (message as { tool_calls?: ChatCompletionMessageToolCall[] }).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;

    const nextCalls: ChatCompletionMessageToolCall[] = [];
    let changed = false;

    toolCalls.forEach((call) => {
      const rawArguments = call?.function?.arguments;
      const resolution = resolveToolArguments(rawArguments);

      if (!resolution.keep) {
        changed = true;
        dropped.push({
          toolCallId: call?.id ?? '',
          toolName: call?.function?.name,
          reason: resolution.reason,
          argsLength: typeof rawArguments === 'string' ? rawArguments.length : 0
        });
        if (call?.id) droppedCallIds.add(call.id);
        return;
      }

      if (resolution.repaired) {
        changed = true;
        nextCalls.push({
          ...call,
          function: { ...call.function, arguments: resolution.arguments }
        });
        return;
      }

      nextCalls.push(call);
    });

    if (!changed) return;

    if (nextCalls.length > 0) {
      replaced.set(index, { ...message, tool_calls: nextCalls } as T);
      return;
    }

    // tool_calls 被清空：先摘除字段，再判断消息本身是否还有内容。
    const withoutToolCalls = { ...message } as T & {
      tool_calls?: ChatCompletionMessageToolCall[];
    };
    delete withoutToolCalls.tool_calls;

    replaced.set(index, hasAssistantContent(withoutToolCalls) ? withoutToolCalls : null);
  });

  let nextMessages: T[] = messages;
  if (replaced.size > 0) {
    nextMessages = [];
    messages.forEach((message, index) => {
      if (!replaced.has(index)) {
        nextMessages.push(message);
        return;
      }
      const next = replaced.get(index);
      if (next) nextMessages.push(next);
    });
  }

  if (droppedCallIds.size > 0) {
    let removedToolMessage = false;
    const filteredMessages: T[] = [];
    nextMessages.forEach((message) => {
      const toolCallId =
        message.role === 'tool' ? (message as { tool_call_id?: string }).tool_call_id : undefined;
      if (toolCallId && droppedCallIds.has(toolCallId)) {
        removedToolMessage = true;
        return;
      }
      filteredMessages.push(message);
    });
    if (removedToolMessage) nextMessages = filteredMessages;
  }

  return { messages: nextMessages, dropped };
};

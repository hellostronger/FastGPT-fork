import { jsonrepair } from 'jsonrepair';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall
} from '../ai/llm/type';

/**
 * 判断 tool call 的 arguments 是否已是严格合法的 JSON 字符串。
 * 只有字符串才可能进入模型请求，因此非字符串一律视为不合法。
 */
export const isValidToolArguments = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * 归一化 tool call 的 arguments 字符串。
 *
 * 流式响应被中断时，累积到的 arguments 可能只有半截 JSON；原样回放会让上游
 * OpenAI 兼容接口以 400 拒绝整个会话。这里保证返回值一定是合法 JSON：
 * - 已合法的字符串原样返回，避免破坏字节级稳定性（幂等）；
 * - 损坏的字符串先用 jsonrepair 修复，修复后仍不合法则退回 '{}'；
 * - 非字符串按旧行为序列化，无法序列化时退回 '{}'。
 */
export const sanitizeToolArguments = (params: unknown): string => {
  if (typeof params !== 'string') {
    try {
      return JSON.stringify(params ?? {});
    } catch {
      return '{}';
    }
  }

  if (!params.trim()) return '{}';
  if (isValidToolArguments(params)) return params;

  try {
    const repaired = jsonrepair(params);
    if (isValidToolArguments(repaired)) return repaired;
  } catch {
    // jsonrepair 无法修复时落到空对象，至少保证请求可被上游接受。
  }
  return '{}';
};

/**
 * 回放前兜底：统一清洗 messages 中 assistant.tool_calls[].function.arguments。
 *
 * 幂等：没有需要修改的消息时直接返回原数组和原对象，已合法的参数保持字节级不变。
 * 只处理 assistant 的 tool_calls，不触碰 role/content 等其它字段。
 */
export const sanitizeToolCallMessages = <T extends ChatCompletionMessageParam>(
  messages: T[]
): T[] => {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  let results: T[] | undefined;

  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const toolCalls = (message as { tool_calls?: ChatCompletionMessageToolCall[] }).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;

    let calls: ChatCompletionMessageToolCall[] | undefined;
    toolCalls.forEach((call, callIndex) => {
      const args = call?.function?.arguments;
      const nextArgs = sanitizeToolArguments(args);
      if (nextArgs === args) return;
      calls ??= [...toolCalls];
      calls[callIndex] = { ...call, function: { ...call.function, arguments: nextArgs } };
    });
    if (!calls) return;

    results ??= [...messages];
    results[index] = { ...message, tool_calls: calls } as T;
  });

  return results ?? messages;
};

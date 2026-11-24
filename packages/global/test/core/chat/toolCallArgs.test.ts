import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from '@fastgpt/global/core/ai/llm/type';
import {
  isValidToolArguments,
  sanitizeToolArguments,
  sanitizeToolCallMessages
} from '@fastgpt/global/core/chat/toolCallArgs';
import { chats2GPTMessages } from '@fastgpt/global/core/chat/adapt';
import { ChatRoleEnum } from '@fastgpt/global/core/chat/constants';
import type { ChatItemMiniType } from '@fastgpt/global/core/chat/type';

/** TD2026112400257 里实际落库的 71 字符残缺串：缺少结尾 `}` 与 questions 字段。 */
const TRUNCATED_ARGS =
  '{"reason": "收集表单数据以生成专属HTML文件", "blockerType": "missing_required_input"';

const expectValidJson = (value: string) => {
  expect(() => JSON.parse(value)).not.toThrow();
};

describe('sanitizeToolArguments', () => {
  it('repairs the truncated tool arguments captured in TD2026112400257 into valid JSON', () => {
    const result = sanitizeToolArguments(TRUNCATED_ARGS);

    expectValidJson(result);
    expect(JSON.parse(result)).toMatchObject({
      reason: '收集表单数据以生成专属HTML文件',
      blockerType: 'missing_required_input'
    });
  });

  it('returns already valid arguments byte-for-byte unchanged', () => {
    const cases = [
      '{"query":"天气","limit":3}',
      ' { "spaced": true } ',
      '{}',
      '"plain-string"',
      '[]'
    ];

    cases.forEach((args) => expect(sanitizeToolArguments(args)).toBe(args));
  });

  it.each([
    ['empty string', '', '{}'],
    ['whitespace only', '   ', '{}'],
    ['null', null, '{}'],
    ['undefined', undefined, '{}'],
    ['object', { a: 1 }, '{"a":1}'],
    ['array', [1, 2], '[1,2]']
  ])('normalizes non-JSON input (%s)', (_label, input, expected) => {
    expect(sanitizeToolArguments(input)).toBe(expected);
  });

  it('falls back to an empty object when the string cannot be repaired', () => {
    // jsonrepair 对多数残缺串都能补全，但结构性冲突（缺少冒号）仍会失败。
    expect(sanitizeToolArguments('{"a": "b" "c"}')).toBe('{}');
  });

  it('detects validity without repairing', () => {
    expect(isValidToolArguments('{"a":1}')).toBe(true);
    expect(isValidToolArguments(TRUNCATED_ARGS)).toBe(false);
    expect(isValidToolArguments({})).toBe(false);
    expect(isValidToolArguments(undefined)).toBe(false);
  });
});

describe('sanitizeToolCallMessages', () => {
  const assistantWithCall = (argumentsText: unknown): ChatCompletionMessageParam =>
    ({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'ask_user', arguments: argumentsText }
        }
      ]
    }) as ChatCompletionMessageParam;

  it('is idempotent and keeps the original array/objects when every argument is valid', () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'hi' },
      assistantWithCall('{"a":1}'),
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' }
    ];

    const result = sanitizeToolCallMessages(messages);

    expect(result).toBe(messages);
    expect(result[1]).toBe(messages[1]);
    expect((result[1] as any).tool_calls[0].function.arguments).toBe('{"a":1}');
  });

  it('repairs only the broken call and leaves siblings untouched', () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_bad',
            type: 'function',
            function: { name: 'ask_user', arguments: TRUNCATED_ARGS }
          },
          {
            id: 'call_good',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' }
          }
        ]
      } as ChatCompletionMessageParam
    ];

    const result = sanitizeToolCallMessages(messages);
    const calls = (result[0] as any).tool_calls;

    expectValidJson(calls[0].function.arguments);
    expect(calls[1].function.arguments).toBe('{"q":"x"}');
    // 原数组和原消息对象不被就地修改。
    expect((messages[0] as any).tool_calls[0].function.arguments).toBe(TRUNCATED_ARGS);
  });
});

describe('chats2GPTMessages replay', () => {
  const buildHistory = (params: string): ChatItemMiniType[] => [
    {
      obj: ChatRoleEnum.AI,
      value: [
        {
          modelResponseId: 'response-1',
          tools: [
            {
              id: 'call_ask',
              functionName: 'ask_user',
              toolName: 'Ask',
              toolAvatar: '',
              params,
              response: 'tool finished'
            }
          ]
        }
      ]
    }
  ];

  it('repairs truncated persisted tool arguments before replay', () => {
    const messages = chats2GPTMessages({
      messages: buildHistory(TRUNCATED_ARGS),
      reserveId: false,
      reserveTool: true
    });

    const assistant = messages.find((item) => item.role === 'assistant') as any;
    expect(assistant).toBeTruthy();
    const args = assistant.tool_calls[0].function.arguments;
    expectValidJson(args);
    expect(args).not.toBe(TRUNCATED_ARGS);
    expect(messages.find((item) => item.role === 'tool')).toMatchObject({
      tool_call_id: 'call_ask',
      content: 'tool finished'
    });
  });

  it('keeps valid persisted arguments byte-for-byte stable', () => {
    const params = '{"query":"天气", "limit":3}';
    const messages = chats2GPTMessages({
      messages: buildHistory(params),
      reserveId: false,
      reserveTool: true
    });

    const assistant = messages.find((item) => item.role === 'assistant') as any;
    expect(assistant.tool_calls[0].function.arguments).toBe(params);
  });
});

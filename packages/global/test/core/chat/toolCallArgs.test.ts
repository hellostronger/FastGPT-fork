import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from '@fastgpt/global/core/ai/llm/type';
import {
  isValidToolArguments,
  reconcileToolCallMessages,
  sanitizeToolArguments
} from '@fastgpt/global/core/chat/toolCallArgs';
import { chats2GPTMessages } from '@fastgpt/global/core/chat/adapt';
import { ChatRoleEnum } from '@fastgpt/global/core/chat/constants';
import type { ChatItemMiniType } from '@fastgpt/global/core/chat/type';

/** TD2026112400257 里实际落库的 71 字符残缺串：缺少结尾 `}` 与 questions 字段。 */
const TRUNCATED_ARGS =
  '{"reason": "收集表单数据以生成专属HTML文件", "blockerType": "missing_required_input"';

const assistantMessage = (
  toolCalls: { id: string; name: string; arguments: unknown }[],
  extra: Partial<ChatCompletionMessageParam> = {}
): ChatCompletionMessageParam =>
  ({
    role: 'assistant',
    ...extra,
    tool_calls: toolCalls.map(({ id, name, arguments: args }) => ({
      id,
      type: 'function',
      function: { name, arguments: args }
    }))
  }) as ChatCompletionMessageParam;

const toolMessage = (id: string): ChatCompletionMessageParam =>
  ({ role: 'tool', tool_call_id: id, content: 'ok' }) as ChatCompletionMessageParam;

describe('isValidToolArguments', () => {
  it('requires a JSON string whose top level is a plain object', () => {
    expect(isValidToolArguments('{"a":1}')).toBe(true);
    expect(isValidToolArguments('{}')).toBe(true);

    // 合法 JSON 但顶层不是对象：上游会以 must be a JSON object 400。
    expect(isValidToolArguments('"just a string"')).toBe(false);
    expect(isValidToolArguments('[1,2,3]')).toBe(false);
    expect(isValidToolArguments('null')).toBe(false);
    expect(isValidToolArguments('1')).toBe(false);

    expect(isValidToolArguments(TRUNCATED_ARGS)).toBe(false);
    expect(isValidToolArguments('not json at all')).toBe(false);
    expect(isValidToolArguments({})).toBe(false);
    expect(isValidToolArguments(undefined)).toBe(false);
  });
});

describe('sanitizeToolArguments', () => {
  it('returns already valid arguments byte-for-byte unchanged', () => {
    const cases = ['{"query":"天气","limit":3}', ' { "spaced": true } ', '{}'];

    cases.forEach((args) => expect(sanitizeToolArguments(args)).toBe(args));
  });

  it.each([
    ['trailing comma', '{"a": 1,}', '{"a": 1}'],
    ['single quotes', "{'a': 1}", '{"a": 1}'],
    ['unquoted key', '{a: 1}', '{"a": 1}']
  ])('repairs real format glitches (%s)', (_label, input, expected) => {
    expect(sanitizeToolArguments(input)).toBe(expected);
  });

  it.each([
    ['production 71-char truncated string', TRUNCATED_ARGS],
    ['interrupted right after a comma', '{"a":1,'],
    ['interrupted after a comma and space', '{"a":1, '],
    ['interrupted mid-object after a comma', '{"a":1,"b":2,'],
    ['truncated at value', '{"age":'],
    ['truncated string value', '{"name": "ab'],
    ['truncated array', '{"a": [1,2'],
    ['valid JSON string (not object)', '"just a string"'],
    ['truncated array literal', '[1,2,3'],
    ['plain text', 'not json at all'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-string null', null],
    ['non-string undefined', undefined],
    ['non-string object', { a: 1 }]
  ])('returns undefined instead of fabricating arguments (%s)', (_label, input) => {
    expect(sanitizeToolArguments(input)).toBeUndefined();
  });
});

describe('reconcileToolCallMessages', () => {
  it('keeps everything byte-for-byte stable and returns the original array/objects when valid', () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'hi' },
      assistantMessage([{ id: 'call_1', name: 'ask_user', arguments: '{"a":1}' }]),
      toolMessage('call_1')
    ];

    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(dropped).toEqual([]);
    expect(result).toBe(messages);
    result.forEach((message, index) => expect(message).toBe(messages[index]));
    expect((result[1] as any).tool_calls[0].function.arguments).toBe('{"a":1}');
  });

  it('drops the production truncated call together with its paired tool message', () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'hi' },
      assistantMessage([{ id: 'call_ask', name: 'ask_user', arguments: TRUNCATED_ARGS }], {
        content: '正在询问'
      }),
      toolMessage('call_ask')
    ];

    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toEqual({
      toolCallId: 'call_ask',
      toolName: 'ask_user',
      reason: 'truncated',
      argsLength: TRUNCATED_ARGS.length
    });

    // assistant 消息保留（有 content），但 tool_calls 字段被清空。
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ role: 'assistant', content: '正在询问' });
    expect((result[1] as any).tool_calls).toBeUndefined();
    // 配对的 role:tool 一并删除。
    expect(result.find((message) => message.role === 'tool')).toBeUndefined();
  });

  it('drops truncated arguments instead of fabricating null', () => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage([{ id: 'call_age', name: 'get_age', arguments: '{"age":' }], {
        content: 'thinking'
      })
    ];

    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(dropped[0]).toMatchObject({
      toolCallId: 'call_age',
      reason: 'truncated',
      argsLength: 7
    });
    expect(JSON.stringify(result)).not.toContain('null');
  });

  it.each([
    ['truncated string value', '{"name": "ab'],
    ['truncated array', '{"a": [1,2'],
    ['interrupted right after a comma', '{"a":1,'],
    ['brace only', '{']
  ])('drops truncated arguments (%s)', (_label, args) => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage([{ id: 'call_x', name: 'tool', arguments: args }], { content: 'x' })
    ];

    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('truncated');
    expect((result[0] as any).tool_calls).toBeUndefined();
  });

  it.each([
    ['trailing comma', '{"a": 1,}', '{"a": 1}'],
    ['single quotes', "{'a': 1}", '{"a": 1}'],
    ['unquoted key', '{a: 1}', '{"a": 1}']
  ])('keeps and repairs real format glitches (%s)', (_label, input, expected) => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage([{ id: 'call_1', name: 'tool', arguments: input }]),
      toolMessage('call_1')
    ];

    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(dropped).toEqual([]);
    expect(result).not.toBe(messages);
    expect((result[0] as any).tool_calls[0].function.arguments).toBe(expected);
    // 配对 tool 消息保留。
    expect(result[1]).toBe(messages[1]);
    // 原消息对象不被就地修改。
    expect((messages[0] as any).tool_calls[0].function.arguments).toBe(input);
  });

  it.each([
    ['valid JSON string (not object)', '"just a string"', 'not-object'],
    ['truncated array literal', '[1,2,3', 'unrepairable'],
    ['plain text', 'not json at all', 'unrepairable'],
    ['non-string arguments', { a: 1 }, 'invalid']
  ])('drops non-object arguments (%s)', (_label, input, reason) => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage([{ id: 'call_1', name: 'tool', arguments: input }], { content: 'x' })
    ];

    const { dropped } = reconcileToolCallMessages(messages);

    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe(reason);
  });

  it('drops only the broken call when one assistant message has two calls', () => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage(
        [
          { id: 'call_bad', name: 'ask_user', arguments: TRUNCATED_ARGS },
          { id: 'call_good', name: 'search', arguments: '{"q":"x"}' }
        ],
        { content: 'go' }
      ),
      toolMessage('call_bad'),
      toolMessage('call_good')
    ];

    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(dropped).toHaveLength(1);
    expect(dropped[0].toolCallId).toBe('call_bad');
    expect((result[0] as any).tool_calls).toHaveLength(1);
    expect((result[0] as any).tool_calls[0].id).toBe('call_good');
    expect((result[0] as any).tool_calls[0].function.arguments).toBe('{"q":"x"}');

    const remainingToolIds = result
      .filter((message) => message.role === 'tool')
      .map((message) => (message as any).tool_call_id);
    expect(remainingToolIds).toEqual(['call_good']);
  });

  it('keeps the assistant message when tool_calls are emptied but content remains', () => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage([{ id: 'call_1', name: 'tool', arguments: TRUNCATED_ARGS }], {
        content: '还能显示的文本'
      })
    ];

    const { messages: result } = reconcileToolCallMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: 'assistant', content: '还能显示的文本' });
    expect((result[0] as any).tool_calls).toBeUndefined();
  });

  it('keeps the assistant message when only reasoning_content remains', () => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage([{ id: 'call_1', name: 'tool', arguments: TRUNCATED_ARGS }], {
        reasoning_content: '推理内容'
      })
    ];

    const { messages: result } = reconcileToolCallMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: 'assistant', reasoning_content: '推理内容' });
    expect((result[0] as any).tool_calls).toBeUndefined();
  });

  it('keeps the assistant message when content is empty but reasoning_content remains', () => {
    const contents = ['', '   ', []];

    contents.forEach((content) => {
      const messages: ChatCompletionMessageParam[] = [
        assistantMessage([{ id: 'call_1', name: 'tool', arguments: TRUNCATED_ARGS }], {
          content: content as any,
          reasoning_content: '推理内容'
        })
      ];

      const { messages: result, dropped } = reconcileToolCallMessages(messages);

      expect(dropped).toHaveLength(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ role: 'assistant', reasoning_content: '推理内容' });
      expect((result[0] as any).tool_calls).toBeUndefined();
    });
  });

  it('removes the whole assistant message when tool_calls are emptied and content is empty', () => {
    const cases: ChatCompletionMessageParam[] = [
      assistantMessage([{ id: 'call_1', name: 'tool', arguments: TRUNCATED_ARGS }]),
      assistantMessage([{ id: 'call_2', name: 'tool', arguments: TRUNCATED_ARGS }], {
        content: '   '
      }),
      assistantMessage([{ id: 'call_3', name: 'tool', arguments: TRUNCATED_ARGS }], {
        content: []
      })
    ];

    cases.forEach((assistant) => {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'user', content: 'hi' },
        assistant,
        toolMessage((assistant as any).tool_calls[0].id)
      ];

      const { messages: result, dropped } = reconcileToolCallMessages(messages);

      expect(dropped).toHaveLength(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(messages[0]);
    });
  });

  it('leaves role:tool messages that belong to kept calls untouched', () => {
    const messages: ChatCompletionMessageParam[] = [
      assistantMessage(
        [
          { id: 'call_bad', name: 'tool', arguments: TRUNCATED_ARGS },
          { id: 'call_good', name: 'tool', arguments: '{"a":1}' }
        ],
        { content: 'x' }
      ),
      toolMessage('call_good')
    ];

    const { messages: result } = reconcileToolCallMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[1]).toBe(messages[1]);
  });

  it('does not touch non-assistant messages or assistant messages without tool_calls', () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' }
    ];

    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(dropped).toEqual([]);
    expect(result).toBe(messages);
  });

  it('returns the same empty array reference for empty input', () => {
    const messages: ChatCompletionMessageParam[] = [];
    const { messages: result, dropped } = reconcileToolCallMessages(messages);

    expect(result).toBe(messages);
    expect(dropped).toEqual([]);
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

  it('drops truncated persisted tool calls instead of repairing them', () => {
    const messages = chats2GPTMessages({
      messages: buildHistory(TRUNCATED_ARGS),
      reserveId: false,
      reserveTool: true
    });

    expect(messages.some((message) => message.role === 'tool')).toBe(false);
    messages
      .filter((message) => message.role === 'assistant')
      .forEach((message) => expect((message as any).tool_calls).toBeUndefined());
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
    expect(messages.find((item) => item.role === 'tool')).toMatchObject({
      tool_call_id: 'call_ask',
      content: 'tool finished'
    });
  });
});

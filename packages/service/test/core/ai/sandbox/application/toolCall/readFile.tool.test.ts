import { describe, expect, it, vi } from 'vitest';
import { sandboxReadFileTool } from '@fastgpt/service/core/ai/sandbox/application/toolCall/readFile.tool';
import { ChatSourceTypeEnum } from '@fastgpt/global/core/chat/constants';

const createSandboxInstance = (content: unknown) =>
  ({
    ensureAvailable: vi.fn(async () => undefined),
    resolveRuntimePath: vi.fn((path: string) =>
      path.startsWith('/') ? path : `/workspace/sessions/chat_1/${path}`
    ),
    provider: {
      readFiles: vi.fn(async (paths: string[]) =>
        paths.map((path) => ({
          path,
          content: typeof content === 'string' ? Buffer.from(content) : content
        }))
      )
    }
  }) as any;

const createFailedSandboxInstance = (file: unknown) =>
  ({
    ensureAvailable: vi.fn(async () => undefined),
    resolveRuntimePath: vi.fn((path: string) => `/workspace/sessions/chat_1/${path}`),
    provider: {
      readFiles: vi.fn(async () => [file])
    }
  }) as any;

describe('sandboxReadFileTool', () => {
  it('reads a whole file', async () => {
    const sandboxInstance = createSandboxInstance('line 1\nline 2\nline 3');

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'notes.txt'
      }
    });

    expect(result.response).toBe('line 1\nline 2\nline 3');
    expect(sandboxInstance.ensureAvailable).toHaveBeenCalledTimes(1);
    expect(sandboxInstance.provider.readFiles).toHaveBeenCalledWith([
      '/workspace/sessions/chat_1/notes.txt'
    ]);
  });

  it('reads absolute files outside workspace for builtin skills', async () => {
    const sandboxInstance = createSandboxInstance('# Skill Creator');
    const path = '/root/.fastgpt/skills/skill-creator/SKILL.md';

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: { path }
    });

    expect(result.response).toBe('# Skill Creator');
    expect(sandboxInstance.resolveRuntimePath).toHaveBeenCalledWith(path, {
      allowAbsolutePath: true
    });
    expect(sandboxInstance.provider.readFiles).toHaveBeenCalledWith([path]);
  });

  it('reads a line range and returns a continuation hint', async () => {
    const sandboxInstance = createSandboxInstance('line 1\nline 2\nline 3\nline 4');

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'notes.txt',
        offset: 2,
        limit: 2
      }
    });

    expect(result.response).toBe(
      'line 2\nline 3\n\n[1 more lines in file. Use offset=4 to continue.]'
    );
  });

  it('decodes non-binary file content', async () => {
    const sandboxInstance = createSandboxInstance('plain text');
    sandboxInstance.provider.readFiles.mockResolvedValueOnce([
      {
        path: 'notes.txt',
        content: 12345
      }
    ]);

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'notes.txt',
        limit: 10
      }
    });

    expect(result.response).toBe('12345');
  });

  it('reports a nullish (0 byte) file instead of an empty string', async () => {
    const sandboxInstance = createSandboxInstance(null);

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'empty.txt'
      }
    });

    expect(result.response).toBe('File is empty (0 bytes): empty.txt');
  });

  it('reports an explicit 0 byte file', async () => {
    const sandboxInstance = createSandboxInstance(Buffer.alloc(0));

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'empty.txt'
      }
    });

    expect(result.response).toBe('File is empty (0 bytes): empty.txt');
  });

  it('reports a 1 byte newline-only file as whitespace content', async () => {
    const sandboxInstance = createSandboxInstance('\n');

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'newline.txt'
      }
    });

    expect(result.response).toBe('File contains only whitespace (1 bytes): newline.txt');
  });

  it('reports a whitespace-only file with its byte size', async () => {
    // 2 空格 + \n + \t + \n + 1 空格 = 6 字节
    const sandboxInstance = createSandboxInstance('  \n\t\n ');

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'spaces.txt'
      }
    });

    expect(result.response).toBe('File contains only whitespace (6 bytes): spaces.txt');
  });

  it('reports an empty file before validating offset bounds', async () => {
    const sandboxInstance = createSandboxInstance('');

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'empty.txt',
        offset: 2
      }
    });

    expect(result.response).toBe('File is empty (0 bytes): empty.txt');
  });

  it('reports a whitespace-only file before validating offset bounds', async () => {
    const sandboxInstance = createSandboxInstance('  \n\t\n ');

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'spaces.txt',
        offset: 2
      }
    });

    expect(result.response).toBe('File contains only whitespace (6 bytes): spaces.txt');
  });

  it('counts raw bytes for a BOM-only Uint8Array', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const sandboxInstance = createSandboxInstance(bom);

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'bom.txt'
      }
    });

    // TextDecoder 会去掉 BOM，字节数必须取原始 Uint8Array 的 byteLength
    expect(result.response).toBe('File contains only whitespace (3 bytes): bom.txt');
  });

  it('rejects an offset beyond the end of the file', async () => {
    const sandboxInstance = createSandboxInstance('line 1\nline 2');

    await expect(
      sandboxReadFileTool.execute({
        sourceType: ChatSourceTypeEnum.app,
        sourceId: 'app_1',
        userId: 'user_1',
        chatId: 'chat_1',
        sandboxInstance,
        params: {
          path: 'notes.txt',
          offset: 3
        }
      })
    ).rejects.toThrow('Offset 3 is beyond end of file (2 lines total)');
  });

  it('returns an actionable message when the first selected line exceeds the byte limit', async () => {
    const sandboxInstance = createSandboxInstance('a'.repeat(50 * 1024 + 1));

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'large.txt'
      }
    });

    expect(result.response).toContain('exceeds 51200 byte limit');
    expect(result.response).toContain("sed -n '1p' large.txt | head -c 51200");
  });

  it('truncates a long file and returns the next offset', async () => {
    const sandboxInstance = createSandboxInstance(
      Array.from({ length: 2001 }, (_, index) => `line ${index + 1}`).join('\n')
    );

    const result = await sandboxReadFileTool.execute({
      sourceType: ChatSourceTypeEnum.app,
      sourceId: 'app_1',
      userId: 'user_1',
      chatId: 'chat_1',
      sandboxInstance,
      params: {
        path: 'large.txt'
      }
    });

    expect(result.response).toContain('line 1\nline 2');
    expect(result.response).toContain(
      '[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]'
    );
  });

  it('throws when provider returns no readable file', async () => {
    const sandboxInstance = createFailedSandboxInstance(undefined);

    await expect(
      sandboxReadFileTool.execute({
        sourceType: ChatSourceTypeEnum.app,
        sourceId: 'app_1',
        userId: 'user_1',
        chatId: 'chat_1',
        sandboxInstance,
        params: {
          path: 'missing.txt'
        }
      })
    ).rejects.toThrow('Failed to read file: missing.txt');
  });

  it('throws provider file errors', async () => {
    const sandboxInstance = createFailedSandboxInstance({
      error: {
        message: 'permission denied'
      }
    });

    await expect(
      sandboxReadFileTool.execute({
        sourceType: ChatSourceTypeEnum.app,
        sourceId: 'app_1',
        userId: 'user_1',
        chatId: 'chat_1',
        sandboxInstance,
        params: {
          path: 'blocked.txt'
        }
      })
    ).rejects.toThrow('Failed to read file: permission denied');
  });
});

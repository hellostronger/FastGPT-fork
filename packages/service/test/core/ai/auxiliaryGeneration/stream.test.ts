import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSourceTypeEnum } from '@fastgpt/global/core/chat/constants';

const mocks = vi.hoisted(() => ({
  createSseStreamContext: vi.fn(),
  getStreamResumeMirror: vi.fn(),
  startStreamResumeMirrorKeepAlive: vi.fn(),
  getSseErrorResponse: vi.fn(),
  clearCookie: vi.fn()
}));

vi.mock('@fastgpt/service/common/response', () => ({
  getSseErrorResponse: mocks.getSseErrorResponse
}));
vi.mock('@fastgpt/service/common/response/sse', () => ({
  createSseStreamContext: mocks.createSseStreamContext
}));
vi.mock('@fastgpt/service/support/permission/auth/common', () => ({
  clearCookie: mocks.clearCookie
}));
vi.mock('@fastgpt/service/core/chat/resume', () => ({
  getStreamResumeMirror: mocks.getStreamResumeMirror,
  startStreamResumeMirrorKeepAlive: mocks.startStreamResumeMirrorKeepAlive
}));

import { createAuxiliaryGenerationStream } from '@fastgpt/service/core/ai/auxiliaryGeneration/stream';

const createParams = () =>
  ({
    req: { headers: {} },
    res: {},
    teamId: 'team-1',
    sourceType: ChatSourceTypeEnum.app,
    sourceId: 'source-1',
    chatId: 'chat-1'
  }) as any;

const createSseContext = () => ({
  write: vi.fn(),
  cleanup: vi.fn(),
  flushResume: vi.fn().mockResolvedValue(undefined)
});

describe('createAuxiliaryGenerationStream resume keepalive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStreamResumeMirror.mockResolvedValue({ touch: vi.fn() });
    mocks.startStreamResumeMirrorKeepAlive.mockReturnValue(vi.fn());
  });

  it('starts resume keepalive once, after the SSE context is created', async () => {
    const mirror = { touch: vi.fn() };
    const sseContext = createSseContext();
    mocks.getStreamResumeMirror.mockResolvedValue(mirror);
    mocks.createSseStreamContext.mockReturnValue(sseContext);

    const context = await createAuxiliaryGenerationStream(createParams());

    expect(mocks.createSseStreamContext).toHaveBeenCalledTimes(1);
    expect(mocks.startStreamResumeMirrorKeepAlive).toHaveBeenCalledTimes(1);
    expect(mocks.startStreamResumeMirrorKeepAlive).toHaveBeenCalledWith(mirror);

    const createOrder = mocks.createSseStreamContext.mock.invocationCallOrder[0];
    const keepAliveOrder = mocks.startStreamResumeMirrorKeepAlive.mock.invocationCallOrder[0];
    expect(keepAliveOrder).toBeGreaterThan(createOrder);

    // Keepalive stop handle is retained and invoked on cleanup.
    const stopMirrorKeepAlive = mocks.startStreamResumeMirrorKeepAlive.mock.results[0].value;
    context.cleanup();
    expect(stopMirrorKeepAlive).toHaveBeenCalledTimes(1);
  });

  it('does not start resume keepalive when the SSE context creation throws', async () => {
    const initError = new Error('sse init failed');
    mocks.createSseStreamContext.mockImplementation(() => {
      throw initError;
    });

    await expect(createAuxiliaryGenerationStream(createParams())).rejects.toThrow(initError);

    expect(mocks.getStreamResumeMirror).toHaveBeenCalledTimes(1);
    expect(mocks.createSseStreamContext).toHaveBeenCalledTimes(1);
    expect(mocks.startStreamResumeMirrorKeepAlive).not.toHaveBeenCalled();
  });
});

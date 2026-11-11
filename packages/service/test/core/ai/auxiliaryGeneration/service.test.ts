import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStopSignalCache } from '@fastgpt/dal/redis/caches/workflowStopSignal';
import { ChatSourceTypeEnum } from '@fastgpt/global/core/chat/constants';
import { UsageSourceEnum } from '@fastgpt/global/support/wallet/usage/constants';

const mocks = vi.hoisted(() => ({
  createStream: vi.fn(),
  createUsage: vi.fn(),
  clearStop: vi.fn(),
  shouldStop: vi.fn()
}));

vi.mock('@fastgpt/service/core/ai/auxiliaryGeneration/stream', () => ({
  createAuxiliaryGenerationStream: mocks.createStream
}));
vi.mock('@fastgpt/service/core/ai/auxiliaryGeneration/usage', () => ({
  createAuxiliaryGenerationUsage: mocks.createUsage
}));
import { runAuxiliaryGeneration } from '@fastgpt/service/core/ai/auxiliaryGeneration/service';

describe('runAuxiliaryGeneration connection lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(WorkflowStopSignalCache.prototype, 'isStopping').mockImplementation(mocks.shouldStop);
    vi.spyOn(WorkflowStopSignalCache.prototype, 'clear').mockImplementation(mocks.clearStop);
    mocks.createStream.mockResolvedValue({
      write: vi.fn(),
      writeError: vi.fn(),
      writeDone: vi.fn(),
      flushResume: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn()
    });
    mocks.createUsage.mockResolvedValue({ pushUsage: vi.fn() });
    mocks.clearStop.mockResolvedValue(undefined);
    mocks.shouldStop.mockImplementation(async () => false);
  });

  afterEach(() => vi.restoreAllMocks());

  it('continues after response close and stops only after the explicit stop signal', async () => {
    const response = new EventEmitter();
    let stopRequested = false;
    mocks.shouldStop.mockImplementation(async () => stopRequested);
    const processorStarted = Promise.withResolvers<() => boolean>();
    const finishProcessor = Promise.withResolvers<void>();
    const run = runAuxiliaryGeneration({
      req: { headers: {} } as any,
      res: response as any,
      teamId: 'team-1',
      tmbId: 'member-1',
      userId: 'user-1',
      isRoot: false,
      lang: 'zh-CN',
      appName: 'ChatAgentHelper',
      sourceType: ChatSourceTypeEnum.chatAgentHelper,
      sourceId: 'helper-1',
      chatId: 'chat-1',
      query: '继续优化',
      files: [],
      data: {},
      histories: [],
      usageSource: UsageSourceEnum.fastgpt,
      processor: async ({ checkIsStopping }) => {
        processorStarted.resolve(checkIsStopping!);
        await finishProcessor.promise;
        return {
          aiResponse: [],
          usage: { modelId: 'model-1', inputTokens: 0, outputTokens: 0 }
        };
      }
    });
    const checkIsStopping = await processorStarted.promise;

    response.emit('close');
    expect(checkIsStopping()).toBe(false);

    stopRequested = true;
    await vi.waitFor(() => expect(checkIsStopping()).toBe(true));
    finishProcessor.resolve();
    await expect(run).resolves.toMatchObject({ aiResponse: [] });
    // 两次 clear 均为预期行为：runAuxiliaryGeneration 开始前清一次上一轮遗留的停止标记
    // （该路径不获取 generationLease，没有按快照清理的兜底），停止控制器 cleanup 收尾再清一次。
    // 两次 delete 幂等、无害。
    expect(mocks.clearStop).toHaveBeenCalledTimes(2);
  });

  it('cleans up the stream when usage initialization fails before the processor starts', async () => {
    const error = new Error('usage initialization failed');
    mocks.createUsage.mockRejectedValueOnce(error);
    const processor = vi.fn();

    await expect(
      runAuxiliaryGeneration({
        req: { headers: {} } as any,
        res: new EventEmitter() as any,
        teamId: 'team-1',
        tmbId: 'member-1',
        userId: 'user-1',
        isRoot: false,
        lang: 'zh-CN',
        appName: 'ChatAgentHelper',
        sourceType: ChatSourceTypeEnum.chatAgentHelper,
        sourceId: 'helper-1',
        chatId: 'chat-1',
        query: '继续优化',
        files: [],
        data: {},
        histories: [],
        usageSource: UsageSourceEnum.fastgpt,
        processor
      })
    ).rejects.toBe(error);

    const stream = await mocks.createStream.mock.results[0].value;
    expect(stream.flushResume).toHaveBeenCalledOnce();
    expect(stream.cleanup).toHaveBeenCalledOnce();
    expect(processor).not.toHaveBeenCalled();
    // 同上：开始前清遗留 + 收尾 cleanup 各一次，共 2 次。
    expect(mocks.clearStop).toHaveBeenCalledTimes(2);
  });
});

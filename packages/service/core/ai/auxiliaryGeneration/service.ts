import { createAuxiliaryGenerationStream } from './stream';
import { createAuxiliaryGenerationUsage } from './usage';
import { createChatStopController, delAgentRuntimeStopSign } from '../../chat/stop';
import type { AuxiliaryGenerationRunParams, AuxiliaryGenerationRunResult } from './type';

/**
 * 执行一次辅助生成。
 *
 * 该函数负责鉴权之后的通用生命周期：余额校验、用量记录、SSE 初始化、
 * stop 标记、processor 调用和结束事件。业务差异由调用方传入的 processor 承担。
 */
export const runAuxiliaryGeneration = async <T>({
  req,
  res,
  teamId,
  tmbId,
  userId,
  isRoot,
  lang,
  appName,
  sourceType,
  sourceId,
  chatId,
  query,
  userAnswer,
  files,
  data,
  histories,
  usageSource,
  processor,
  maxFiles,
  customPdfParse,
  onStreamContextReady
}: AuxiliaryGenerationRunParams<T>): Promise<
  AuxiliaryGenerationRunResult & {
    streamContext: Awaited<ReturnType<typeof createAuxiliaryGenerationStream>>;
  }
> => {
  const startedAt = Date.now();
  // 开始前清掉上一轮可能遗留的停止标记：本路径不获取 generationLease，
  // 没有 tryStartChatGenerationLease 里按快照清理的兜底；留着会让本轮首次
  // checkIsStopping() 即为 true，整轮空转（stop 标记 TTL 60s）。
  await delAgentRuntimeStopSign({ sourceType, sourceId, chatId });
  const stopController = await createChatStopController({
    sourceType,
    sourceId,
    chatId
  });
  let streamContext: Awaited<ReturnType<typeof createAuxiliaryGenerationStream>> | undefined;

  try {
    streamContext = await createAuxiliaryGenerationStream({
      req,
      res,
      teamId,
      sourceType,
      sourceId,
      chatId
    });
    onStreamContextReady?.(streamContext);
    const usageContext = await createAuxiliaryGenerationUsage({
      teamId,
      tmbId,
      appName,
      sourceType,
      sourceId,
      usageSource
    });
    const result = await processor({
      query,
      userAnswer,
      files,
      data,
      histories,
      requestOrigin: req.headers.origin,
      streamWriter: streamContext.write,
      checkIsStopping: stopController.checkIsStopping,
      usageSink: usageContext.pushUsage,
      maxFiles,
      customPdfParse,
      user: {
        teamId,
        tmbId,
        userId,
        isRoot,
        lang
      }
    });

    streamContext.writeDone();

    return {
      ...result,
      durationSeconds: +((Date.now() - startedAt) / 1000).toFixed(2),
      streamContext
    };
  } catch (error) {
    await streamContext?.flushResume().catch(() => undefined);
    streamContext?.cleanup();
    throw error;
  } finally {
    await stopController.cleanup();
  }
};

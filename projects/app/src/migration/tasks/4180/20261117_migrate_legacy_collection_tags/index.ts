import { z } from 'zod';
import { SystemMigrationStatusEnum } from '@fastgpt/global/migration/constants';
import { Types } from '@fastgpt/service/common/mongo';
import type { SystemMigrationContext } from '@/migration/registry';
import { systemMigrationBatchSize } from '@/migration/constants';
import {
  countDanglingTagReferences,
  getLegacyCollectionTagSnapshot,
  migrateLegacyCollectionTagBatch,
  readLegacyCollectionTagBatch
} from './service';

const CursorSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/)
  .nullable();
const CheckpointSchema = z.object({
  version: z.literal(1),
  stage: z.enum(['definitions', 'validation']),
  endId: CursorSchema,
  lastId: CursorSchema,
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  copied: z.number().int().nonnegative(),
  remapped: z.number().int().nonnegative(),
  collectionRefsUpdated: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative()
});
type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * 150 → 1.6.0 标签定义升级：把 `dataset_collection_tags` 按原 `_id` 复制到 v2。
 *
 * 150 的 collection 以 `tags: [{ tagId: "<v1 _id>", value }]` 引用定义，保留 `_id` 后
 * collection 无需改写；只有同一知识库存在同名重复定义时，才把引用改到保留的 id。
 * 任务幂等：已复制的 _id 直接跳过，断点续跑不会重复写入。
 */
export const migrateLegacyCollectionTags = async (context: SystemMigrationContext) => {
  let checkpoint = await context.getCheckpoint(CheckpointSchema);
  if (!checkpoint) {
    const snapshot = await getLegacyCollectionTagSnapshot();
    checkpoint = {
      version: 1,
      stage: 'definitions',
      endId: snapshot.endId ? String(snapshot.endId) : null,
      lastId: null,
      current: 0,
      total: snapshot.total,
      copied: 0,
      remapped: 0,
      collectionRefsUpdated: 0,
      invalid: 0
    };
    await context.saveCheckpoint(checkpoint);
  }
  let state: Checkpoint = checkpoint;

  // 全新 160 环境没有 150 的 v1 标签定义，跳过 collection 引用扫描。
  if (!state.endId) {
    await context.reportProgress({
      key: 'definitions',
      status: SystemMigrationStatusEnum.succeeded,
      current: 0,
      total: 0
    });
    await context.reportProgress({
      key: 'validation',
      status: SystemMigrationStatusEnum.succeeded
    });
    return {
      definitionsCopied: 0,
      remappedDefinitions: 0,
      collectionRefsUpdated: 0,
      invalidDefinitions: 0,
      danglingReferences: 0
    };
  }

  const reportDefinitions = (
    status: SystemMigrationStatusEnum.running | SystemMigrationStatusEnum.succeeded
  ) =>
    context.reportProgress({
      key: 'definitions',
      status,
      current: state.current,
      // 迁移期间新增定义时 current 可能超过初始 total。
      total: Math.max(state.total, state.current)
    });

  if (state.stage === 'definitions') {
    await reportDefinitions(SystemMigrationStatusEnum.running);

    for (;;) {
      const endId = state.endId;
      if (!endId) break;
      context.signal.throwIfAborted();
      await context.assertActive();

      const docs = await readLegacyCollectionTagBatch({
        lastId: state.lastId ? new Types.ObjectId(state.lastId) : null,
        endId: new Types.ObjectId(endId),
        limit: systemMigrationBatchSize
      });
      if (docs.length === 0) break;

      const result = await migrateLegacyCollectionTagBatch({ docs });
      state = {
        ...state,
        lastId: String(docs[docs.length - 1]._id),
        current: state.current + docs.length,
        copied: state.copied + result.copied,
        remapped: state.remapped + result.remapped,
        collectionRefsUpdated: state.collectionRefsUpdated + result.collectionRefsUpdated,
        invalid: state.invalid + result.invalid
      };
      await context.saveCheckpoint(state);
      await reportDefinitions(SystemMigrationStatusEnum.running);
    }

    await reportDefinitions(SystemMigrationStatusEnum.succeeded);
    state = { ...state, stage: 'validation' };
    await context.saveCheckpoint(state);
  }

  await context.reportProgress({ key: 'validation', status: SystemMigrationStatusEnum.running });
  await context.assertActive();
  const danglingReferences = await countDanglingTagReferences();
  if (danglingReferences > 0) {
    // 历史数据可能引用已被删除的标签定义；160 展示时会自动过滤，这里只提示不阻断。
    context.logger.warn('Collection tags reference missing definitions', { danglingReferences });
  }
  await context.reportProgress({ key: 'validation', status: SystemMigrationStatusEnum.succeeded });

  return {
    definitionsCopied: state.copied,
    remappedDefinitions: state.remapped,
    collectionRefsUpdated: state.collectionRefsUpdated,
    invalidDefinitions: state.invalid,
    danglingReferences
  };
};

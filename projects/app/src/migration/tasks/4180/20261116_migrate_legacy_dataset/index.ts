import { z } from 'zod';
import { Types } from '@fastgpt/service/common/mongo';
import { SystemMigrationStatusEnum } from '@fastgpt/global/migration/constants';
import type { SystemMigrationContext } from '@/migration/registry';
import {
  deleteLegacyDataset,
  findLegacyDatasets,
  migrateDatasetFieldBatch,
  migrateDatasetSynonyms,
  migrateLegacySynonymData,
  readDatasetFieldBatch,
  type LegacyDatasetMigrationResult
} from './service';

const CheckpointSchema = z.object({
  version: z.literal(1),
  lastId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable()
});

/**
 * 150 → 1.6.0 知识库数据升级：
 * 1) 删除 1.6.0 已移除的 database / structureDocument 知识库及关联资源；
 * 2) 把顶层 keep_* 解析开关迁移到 sangforFileParseConfig 并清理旧字段；
 * 3) 把同义词配置/映射升级到新的 schemaVersion；
 * 4) 回填 dataset_datas.synonymVersion 并清理 150 同义词流程标记。
 *
 * 各阶段均幂等：删除按实时数据重算，字段迁移按 _id 游标断点推进，同义词按 schemaVersion 跳过已迁移数据。
 */
export const migrateLegacyDataset = async (
  context: SystemMigrationContext
): Promise<LegacyDatasetMigrationResult> => {
  let legacyDeleted = 0;
  let legacySkipped = 0;
  let datasetsUpdated = 0;

  // 阶段 1：删除已移除类型的知识库（含级联资源）
  await context.reportProgress({
    key: 'legacyDatasets',
    status: SystemMigrationStatusEnum.running
  });
  const legacyDatasets = await findLegacyDatasets();
  // database / structureDocument 功能在 1.6.0 已整体移除，相关数据不再可用，直接删除（不做应用引用检查）。
  for (const dataset of legacyDatasets) {
    context.signal.throwIfAborted();
    await context.assertActive();

    const datasetId = String(dataset._id);
    try {
      await deleteLegacyDataset(dataset);
      legacyDeleted += 1;
    } catch (error) {
      legacySkipped += 1;
      context.logger.warn('Failed to delete legacy dataset', {
        datasetId,
        name: dataset.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  await context.reportProgress({
    key: 'legacyDatasets',
    status: SystemMigrationStatusEnum.succeeded,
    params: { deleted: legacyDeleted, skipped: legacySkipped }
  });

  // 阶段 2：keep_* → sangforFileParseConfig
  await context.reportProgress({
    key: 'datasetFields',
    status: SystemMigrationStatusEnum.running
  });
  let checkpoint =
    (await context.getCheckpoint(CheckpointSchema)) ??
    ({ version: 1, lastId: null } satisfies z.infer<typeof CheckpointSchema>);

  while (true) {
    context.signal.throwIfAborted();
    await context.assertActive();

    const lastId = checkpoint.lastId ? new Types.ObjectId(checkpoint.lastId) : null;
    const rows = await readDatasetFieldBatch({ lastId });
    if (rows.length === 0) break;

    datasetsUpdated += await migrateDatasetFieldBatch(rows);
    checkpoint = { version: 1, lastId: String(rows[rows.length - 1]!._id) };
    await context.saveCheckpoint(checkpoint);
  }
  await context.reportProgress({
    key: 'datasetFields',
    status: SystemMigrationStatusEnum.succeeded,
    params: { updated: datasetsUpdated }
  });

  // 阶段 3：同义词结构升级
  await context.reportProgress({
    key: 'synonyms',
    status: SystemMigrationStatusEnum.running
  });
  const synonymStats = await migrateDatasetSynonyms();
  if (synonymStats.warnings.length > 0) {
    context.logger.warn('Dataset synonym migration warnings', {
      warnings: synonymStats.warnings.slice(0, 50),
      failed: synonymStats.failed
    });
  }
  await context.reportProgress({
    key: 'synonyms',
    status: SystemMigrationStatusEnum.succeeded,
    params: {
      migrated: synonymStats.migrated,
      disabled: synonymStats.disabled,
      failed: synonymStats.failed
    }
  });

  // 阶段 4：dataset_datas 的同义词派生版本与旧流程标记
  await context.reportProgress({
    key: 'synonymData',
    status: SystemMigrationStatusEnum.running
  });
  await context.assertActive();
  const synonymDataStats = await migrateLegacySynonymData(context);
  await context.reportProgress({
    key: 'synonymData',
    status: SystemMigrationStatusEnum.succeeded,
    params: {
      datasets: synonymDataStats.datasetsUpdated,
      versioned: synonymDataStats.datasVersioned,
      cleaned: synonymDataStats.datasCleaned
    }
  });

  return {
    legacyDeleted,
    legacySkipped,
    datasetsUpdated,
    synonymsMigrated: synonymStats.migrated,
    synonymsDisabled: synonymStats.disabled,
    synonymsFailed: synonymStats.failed,
    synonymDatasetsUpdated: synonymDataStats.datasetsUpdated,
    synonymDataVersioned: synonymDataStats.datasVersioned,
    synonymDataCleaned: synonymDataStats.datasCleaned
  };
};

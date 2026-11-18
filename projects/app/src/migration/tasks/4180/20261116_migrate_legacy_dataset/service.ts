import { Types } from '@fastgpt/service/common/mongo';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import {
  DatasetSynonymSchemaVersion,
  type DatasetSynonymInputMappingType
} from '@fastgpt/global/core/dataset/synonym';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetData } from '@fastgpt/service/core/dataset/data/schema';
import { MongoDatasetCollectionTags } from '@fastgpt/service/core/dataset/tag/schema';
import { MongoDatasetCollectionTagsV2 } from '@fastgpt/service/core/dataset/tag/schemaV2';
import {
  MongoDatasetSynonym,
  MongoDatasetSynonymMapping
} from '@fastgpt/service/core/dataset/synonym/schema';
import {
  normalizeSynonymInputMappings,
  normalizeSynonymTerm
} from '@fastgpt/service/core/dataset/synonym/utils';
import { delDatasetRelevantData } from '@fastgpt/service/core/dataset/controller';
import { deleteDatasetsImmediate } from '@fastgpt/service/core/dataset/delete/processor';
import { removeDatasetVectorIndexes } from '@fastgpt/service/core/dataset/vectorData/service';
import { removeImageByPath } from '@fastgpt/service/common/file/image/controller';
import { resourcePermissionRepo } from '@fastgpt/service/support/permission/repository/resourcePermissionRepo';

/** 1.6.0 已移除的知识库类型，数据与关联资源必须清理。 */
export const LEGACY_DATASET_TYPES = ['database', 'structureDocument'] as const;

/** 150 顶层文档解析开关，1.6.0 统一迁移到 sangforFileParseConfig。 */
export const LEGACY_PARSE_FIELDS = [
  'keep_header_footer',
  'keep_appendix',
  'image_analysis',
  'chart_analysis'
] as const;

const DATASET_FIELD_BATCH_SIZE = 100;
const MAPPING_UPDATE_BATCH_SIZE = 500;

export type LegacyDatasetRow = {
  _id: Types.ObjectId;
  teamId: Types.ObjectId;
  name?: string;
  avatar?: string;
};

type DatasetFieldRow = {
  _id: Types.ObjectId;
  sangforFileParseConfig?: Record<string, unknown> | null;
  keep_header_footer?: unknown;
  keep_appendix?: unknown;
  image_analysis?: unknown;
  chart_analysis?: unknown;
};

type LegacySynonymConfig = {
  _id?: unknown;
  teamId?: unknown;
  datasetId?: unknown;
  schemaVersion?: unknown;
};

type LegacySynonymMapping = {
  _id?: unknown;
  synonymFileId?: unknown;
  fileVersion?: unknown;
  standardizedTerm?: unknown;
  synonymTerms?: unknown;
  createTime?: unknown;
  createdAt?: unknown;
  updateTime?: unknown;
  updatedTime?: unknown;
};

export type LegacyDatasetMigrationResult = {
  legacyDeleted: number;
  legacySkipped: number;
  datasetsUpdated: number;
  synonymsMigrated: number;
  synonymsDisabled: number;
  synonymsFailed: number;
  synonymDatasetsUpdated: number;
  synonymDataVersioned: number;
  synonymDataCleaned: number;
};

const toObjectId = (value: unknown) => {
  if (value instanceof Types.ObjectId) return value;
  const text = String(value ?? '');
  return Types.ObjectId.isValid(text) ? new Types.ObjectId(text) : undefined;
};

const toBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

const toDate = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/** 读取全部 legacy 类型（含软删除）的知识库。 */
export const findLegacyDatasets = async (): Promise<LegacyDatasetRow[]> =>
  MongoDataset.collection
    .find(
      { type: { $in: [...LEGACY_DATASET_TYPES] } },
      { projection: { _id: 1, teamId: 1, name: 1, avatar: 1 } }
    )
    .toArray() as unknown as LegacyDatasetRow[];

/**
 * 删除单个 legacy 知识库及其关联资源。
 * 顺序与 1.6.0 正式删除流程一致：先清理向量索引等 DDL，再在事务内删除数据、权限与知识库本体。
 */
export const deleteLegacyDataset = async (dataset: LegacyDatasetRow) => {
  const teamId = String(dataset.teamId);
  const datasetId = String(dataset._id);

  await removeDatasetVectorIndexes({ teamId, datasetIds: [datasetId] });
  await MongoDatasetCollectionTags.deleteMany({ teamId, datasetId });
  await MongoDatasetCollectionTagsV2.deleteMany({ teamId, datasetId });
  await deleteDatasetsImmediate({ teamId, datasetIds: [datasetId] });

  if (dataset.avatar) {
    try {
      await removeImageByPath(dataset.avatar);
    } catch {
      // 头像清理失败不阻塞知识库删除。
    }
  }

  await mongoSessionRun(async (session) => {
    await delDatasetRelevantData({
      datasets: [{ _id: datasetId, teamId }],
      session
    });
    await resourcePermissionRepo.deleteByResources({
      teamId,
      resourceType: PerResourceTypeEnum.dataset,
      resourceIds: [datasetId],
      session
    });
    await MongoDataset.deleteMany({ _id: dataset._id, teamId: dataset.teamId }, { session });
  });
};

/** 按 _id 游标读取仍带 150 顶层解析开关的知识库。 */
export const readDatasetFieldBatch = async ({
  lastId,
  limit = DATASET_FIELD_BATCH_SIZE
}: {
  lastId: Types.ObjectId | null;
  limit?: number;
}): Promise<DatasetFieldRow[]> =>
  MongoDataset.collection
    .find(
      {
        ...(lastId ? { _id: { $gt: lastId } } : {}),
        // 只匹配 150 才有的顶层字段：160 新建知识库不会写入 sangforFileParseConfig，
        // 不能仅因缺少该字段就回填默认值，否则全新 160 环境也会被写入。
        $or: LEGACY_PARSE_FIELDS.map((field) => ({ [field]: { $exists: true } }))
      },
      {
        projection: {
          _id: 1,
          sangforFileParseConfig: 1,
          keep_header_footer: 1,
          keep_appendix: 1,
          image_analysis: 1,
          chart_analysis: 1
        }
      }
    )
    .sort({ _id: 1 })
    .limit(limit)
    .toArray() as unknown as DatasetFieldRow[];

/** 把 150 顶层解析开关写入 sangforFileParseConfig，并清理旧字段。 */
export const migrateDatasetFieldBatch = async (rows: DatasetFieldRow[]): Promise<number> => {
  if (rows.length === 0) return 0;

  const operations = rows.map((row) => {
    const existing = row.sangforFileParseConfig ?? {};
    const keepHeaderFooter =
      toBoolean(row.keep_header_footer) ?? toBoolean(existing.keep_header_footer) ?? false;
    const keepAppendix =
      toBoolean(row.keep_appendix) ?? toBoolean(existing.keep_appendix) ?? true;
    const imageAnalysis =
      toBoolean(row.image_analysis) ?? toBoolean(existing.image_analysis) ?? false;
    const chartAnalysis =
      toBoolean(row.chart_analysis) ?? toBoolean(existing.chart_analysis) ?? false;

    return {
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            sangforFileParseConfig: {
              keep_header_footer: keepHeaderFooter,
              keep_appendix: keepAppendix,
              image_analysis: imageAnalysis,
              chart_analysis: chartAnalysis
            }
          },
          $unset: {
            keep_header_footer: '',
            keep_appendix: '',
            image_analysis: '',
            chart_analysis: ''
          }
        }
      }
    };
  });

  await MongoDataset.collection.bulkWrite(operations as never, { ordered: false });
  return operations.length;
};

export type SynonymMigrationStats = {
  migrated: number;
  disabled: number;
  failed: number;
  warnings: string[];
};

const clearPendingSynonymFields = {
  pendingVersion: '',
  pendingFileId: '',
  pendingFileName: '',
  pendingSize: '',
  pendingUploaderId: '',
  pendingUploadTime: ''
};

/**
 * 把 150 同义词结构升级到 1.6.0：
 * config 补 schemaVersion/version/enabled，mapping 补 logicalMappingId/fileVersion、
 * 规范化字段、fingerprint 与 createTime/updateTime。
 * 已有 schemaVersion 的配置直接跳过；空配置置为 disabled。
 */
export const migrateDatasetSynonyms = async (): Promise<SynonymMigrationStats> => {
  const stats: SynonymMigrationStats = { migrated: 0, disabled: 0, failed: 0, warnings: [] };
  const configs = (await MongoDatasetSynonym.collection
    .find({ schemaVersion: { $ne: DatasetSynonymSchemaVersion } })
    .toArray()) as unknown as LegacySynonymConfig[];
  if (configs.length === 0) return stats;

  const groups = new Map<string, LegacySynonymConfig[]>();
  for (const config of configs) {
    const key = `${String(config.teamId)}:${String(config.datasetId)}`;
    const group = groups.get(key) ?? [];
    group.push(config);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const config = group[0]!;
    const configId = toObjectId(config._id);
    const teamId = toObjectId(config.teamId);
    const datasetId = toObjectId(config.datasetId);
    if (group.length !== 1 || !configId || !teamId || !datasetId) {
      stats.failed += 1;
      stats.warnings.push(
        `synonym config skipped: dataset=${String(config.datasetId)} reason=${
          group.length !== 1 ? 'duplicate config' : 'invalid ids'
        }`
      );
      continue;
    }

    const mappings = (await MongoDatasetSynonymMapping.collection
      .find({ teamId, datasetId })
      .toArray()) as unknown as LegacySynonymMapping[];

    try {
      if (mappings.length === 0) {
        await MongoDatasetSynonym.collection.updateOne(
          { _id: configId, schemaVersion: { $ne: DatasetSynonymSchemaVersion } },
          {
            $set: {
              schemaVersion: DatasetSynonymSchemaVersion,
              version: 1,
              enabled: false,
              updateTime: new Date()
            },
            $unset: clearPendingSynonymFields
          }
        );
        stats.disabled += 1;
        continue;
      }

      const sourceMappings: DatasetSynonymInputMappingType[] = [];
      const mappingIds: Types.ObjectId[] = [];
      for (const mapping of mappings) {
        const mappingId = toObjectId(mapping._id);
        if (
          !mappingId ||
          typeof mapping.standardizedTerm !== 'string' ||
          !Array.isArray(mapping.synonymTerms)
        ) {
          throw new Error(`invalid synonym mapping ${String(mapping._id)}`);
        }
        // 映射必须属于当前 config，且仍是未升级的 legacy 版本；否则说明数据不一致。
        if (mapping.synonymFileId && String(mapping.synonymFileId) !== String(configId)) {
          throw new Error(`synonym mapping ${String(mappingId)} belongs to another config`);
        }
        if (mapping.fileVersion !== undefined && mapping.fileVersion !== 1) {
          throw new Error(`synonym mapping ${String(mappingId)} is not legacy version`);
        }
        sourceMappings.push({
          standardizedTerm: mapping.standardizedTerm,
          synonymTerms: mapping.synonymTerms as string[]
        });
        mappingIds.push(mappingId);
      }

      const normalized = normalizeSynonymInputMappings(sourceMappings);
      if (normalized.length !== sourceMappings.length) {
        throw new Error('normalized synonym mapping count mismatch');
      }
      const normalizedByTerm = new Map(
        normalized.map((item) => [item.normalizedStandardizedTerm, item])
      );

      const operations = mappings.map((mapping, index) => {
        const mappingId = mappingIds[index]!;
        const item = normalizedByTerm.get(normalizeSynonymTerm(sourceMappings[index]!.standardizedTerm));
        if (!item) throw new Error(`normalized synonym mapping missing: ${String(mappingId)}`);

        const createTime =
          toDate(mapping.createTime) ??
          toDate(mapping.createdAt) ??
          toDate(mapping.updateTime) ??
          mappingId.getTimestamp();
        const updateTime = toDate(mapping.updateTime) ?? toDate(mapping.updatedTime) ?? createTime;

        return {
          updateOne: {
            filter: { _id: mappingId },
            update: {
              $set: {
                logicalMappingId: mappingId,
                fileVersion: 1,
                standardizedTerm: item.standardizedTerm,
                normalizedStandardizedTerm: item.normalizedStandardizedTerm,
                synonymTerms: item.synonymTerms,
                normalizedSynonymTerms: item.normalizedSynonymTerms,
                allTerms: item.allTerms,
                fingerprint: item.fingerprint,
                createTime,
                updateTime
              }
            }
          }
        };
      });

      for (let start = 0; start < operations.length; start += MAPPING_UPDATE_BATCH_SIZE) {
        await MongoDatasetSynonymMapping.collection.bulkWrite(
          operations.slice(start, start + MAPPING_UPDATE_BATCH_SIZE) as never,
          { ordered: true }
        );
      }

      await MongoDatasetSynonym.collection.updateOne(
        { _id: configId, schemaVersion: { $ne: DatasetSynonymSchemaVersion } },
        {
          $set: {
            schemaVersion: DatasetSynonymSchemaVersion,
            version: 1,
            enabled: true,
            updateTime: new Date()
          },
          $unset: clearPendingSynonymFields
        }
      );
      stats.migrated += 1;
    } catch (error) {
      stats.failed += 1;
      stats.warnings.push(
        `synonym migration failed: dataset=${String(config.datasetId)} reason=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return stats;
};

export type LegacySynonymDataMigrationStats = {
  datasetsUpdated: number;
  datasVersioned: number;
  datasCleaned: number;
};

/**
 * 迁移 150 同义词标准化留下的 dataset_datas 状态：
 * 1) 150 没有 synonymVersion，迁移后的配置统一为 version=1；对未标记版本的数据回填 1，
 *    使 160 检索仍能按当前词表装饰 synonymMappings，也避免下次改词表时把全部存量数据误判为待重建。
 * 2) 清理 160 已删除的 synonymFileIds / synonymProcessing 标记。
 *
 * synonymRebuildingVersion 是 160 重建任务的领取标记，150 没有该字段，这里不回填。
 * 用 fileId 识别从 150 迁移过来的配置（160 新建配置不写该字段），并限定 version=1，
 * 避免重复执行时覆盖升级后已经推进的词表版本。
 */
export const migrateLegacySynonymData = async (): Promise<LegacySynonymDataMigrationStats> => {
  // 150 的 datasets 一定有 synonymFiles 字段（数组默认 []），160 新建知识库没有；
  // 全新 160 环境据此跳过 dataset_datas 全表扫描，避免启动迁移产生额外耗时。
  const [legacyDataset, legacyConfig] = await Promise.all([
    MongoDataset.collection.findOne({ synonymFiles: { $exists: true } }, { projection: { _id: 1 } }),
    MongoDatasetSynonym.collection.findOne({ fileId: { $exists: true } }, { projection: { _id: 1 } })
  ]);
  if (!legacyDataset && !legacyConfig) {
    return { datasetsUpdated: 0, datasVersioned: 0, datasCleaned: 0 };
  }

  const configs = (await MongoDatasetSynonym.collection
    .find(
      {
        schemaVersion: DatasetSynonymSchemaVersion,
        version: 1,
        fileId: { $exists: true }
      },
      { projection: { teamId: 1, datasetId: 1 } }
    )
    .toArray()) as unknown as Array<{ teamId?: unknown; datasetId?: unknown }>;

  let datasetsUpdated = 0;
  let datasVersioned = 0;
  for (const config of configs) {
    const teamId = toObjectId(config.teamId);
    const datasetId = toObjectId(config.datasetId);
    if (!teamId || !datasetId) continue;

    const result = await MongoDatasetData.collection.updateMany(
      { teamId, datasetId, synonymVersion: { $exists: false } },
      { $set: { synonymVersion: 1 } }
    );
    datasetsUpdated += 1;
    datasVersioned += result.modifiedCount;
  }

  const cleaned = await MongoDatasetData.collection.updateMany(
    {
      $or: [{ synonymFileIds: { $exists: true } }, { synonymProcessing: { $exists: true } }]
    },
    { $unset: { synonymFileIds: '', synonymProcessing: '' } }
  );

  return {
    datasetsUpdated,
    datasVersioned,
    datasCleaned: cleaned.modifiedCount
  };
};

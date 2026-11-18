import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemMigrationContext } from '@/migration/registry';
import type { SystemMigrationProgressInput } from '@fastgpt/global/migration/schema';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTagTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoDatasetCollectionTags } from '@fastgpt/service/core/dataset/tag/schema';
import { MongoDatasetCollectionTagsV2 } from '@fastgpt/service/core/dataset/tag/schemaV2';
import { migrateLegacyCollectionTags } from '@/migration/tasks/4180/20261117_migrate_legacy_collection_tags';

vi.mock('@/migration/constants', () => ({ systemMigrationBatchSize: 1 }));

const createContext = () => {
  let checkpoint: Record<string, unknown> | undefined;
  const context = {
    migrationId: '20261117_migrate_legacy_collection_tags',
    runId: 'test-run',
    signal: new AbortController().signal,
    getCheckpoint: async (schema) => (checkpoint === undefined ? undefined : schema.parse(checkpoint)),
    saveCheckpoint: vi.fn(async (value: Record<string, unknown>) => {
      checkpoint = structuredClone(value);
    }),
    assertActive: vi.fn(async () => undefined),
    reportProgress: vi.fn(async (_value: SystemMigrationProgressInput) => undefined),
    getFailedRecords: vi.fn(async () => []),
    reportFailedRecords: vi.fn(async () => undefined),
    fail: vi.fn(async () => {
      throw new Error('Blocking tasks must throw');
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  } satisfies SystemMigrationContext;
  return { context, getCheckpoint: () => checkpoint };
};

const createIds = () => {
  const teamId = new Types.ObjectId();
  const tmbId = new Types.ObjectId();
  const datasetId = new Types.ObjectId();
  return { teamId, tmbId, datasetId };
};

const seedDataset = async ({ teamId, tmbId, datasetId }: ReturnType<typeof createIds>) =>
  MongoDataset.collection.insertOne({
    _id: datasetId,
    teamId,
    tmbId,
    name: 'dataset',
    type: 'dataset'
  });

const seedCollection = async ({
  teamId,
  tmbId,
  datasetId,
  tags
}: ReturnType<typeof createIds> & { tags: unknown[] }) =>
  MongoDatasetCollection.collection.insertOne({
    _id: new Types.ObjectId(),
    teamId,
    tmbId,
    datasetId,
    name: 'file',
    type: 'file',
    tags
  });

describe('migrateLegacyCollectionTags', () => {
  beforeEach(async () => {
    await Promise.all([
      MongoDataset.collection.deleteMany({}),
      MongoDatasetCollection.collection.deleteMany({}),
      MongoDatasetCollectionTags.collection.deleteMany({}),
      MongoDatasetCollectionTagsV2.collection.deleteMany({})
    ]);
  });

  it('copies legacy definitions with the same id and keeps collection tag references unchanged', async () => {
    const ids = createIds();
    await seedDataset(ids);
    const tagId = new Types.ObjectId();
    await MongoDatasetCollectionTags.collection.insertOne({
      _id: tagId,
      teamId: ids.teamId,
      datasetId: ids.datasetId,
      tag: 'priority',
      tagType: DatasetCollectionTagTypeEnum.number
    });
    const collectionId = (
      await seedCollection({ ...ids, tags: [{ tagId: String(tagId), value: 3 }] })
    ).insertedId;

    const { context } = createContext();
    const result = await migrateLegacyCollectionTags(context);

    expect(result).toMatchObject({
      definitionsCopied: 1,
      remappedDefinitions: 0,
      collectionRefsUpdated: 0,
      invalidDefinitions: 0,
      danglingReferences: 0
    });
    const migrated = await MongoDatasetCollectionTagsV2.collection.findOne({ _id: tagId });
    expect(migrated).toMatchObject({
      tag: 'priority',
      tagType: DatasetCollectionTagTypeEnum.number,
      fromMigration: false
    });
    expect(String(migrated?.teamId)).toBe(String(ids.teamId));
    expect(String(migrated?.datasetId)).toBe(String(ids.datasetId));
    // collection 的 tags 不需要改写
    const collection = await MongoDatasetCollection.collection.findOne({ _id: collectionId });
    expect(collection?.tags).toEqual([{ tagId: String(tagId), value: 3 }]);
    // 旧表保留
    await expect(
      MongoDatasetCollectionTags.collection.countDocuments({ _id: tagId })
    ).resolves.toBe(1);
  });

  it('defaults a missing tagType to string', async () => {
    const ids = createIds();
    await seedDataset(ids);
    const tagId = new Types.ObjectId();
    await MongoDatasetCollectionTags.collection.insertOne({
      _id: tagId,
      teamId: ids.teamId,
      datasetId: ids.datasetId,
      tag: 'plain'
    });

    const { context } = createContext();
    await migrateLegacyCollectionTags(context);

    await expect(
      MongoDatasetCollectionTagsV2.collection.findOne({ _id: tagId })
    ).resolves.toMatchObject({ tag: 'plain', tagType: DatasetCollectionTagTypeEnum.string });
  });

  it('keeps the earliest duplicate definition and rewrites collection references', async () => {
    const ids = createIds();
    await seedDataset(ids);
    const keptTagId = new Types.ObjectId();
    const duplicateTagId = new Types.ObjectId();
    await MongoDatasetCollectionTags.collection.insertMany([
      { _id: keptTagId, teamId: ids.teamId, datasetId: ids.datasetId, tag: 'safety' },
      { _id: duplicateTagId, teamId: ids.teamId, datasetId: ids.datasetId, tag: 'safety' }
    ]);
    const collectionId = (
      await seedCollection({ ...ids, tags: [{ tagId: String(duplicateTagId), value: 'A' }] })
    ).insertedId;

    const { context } = createContext();
    const result = await migrateLegacyCollectionTags(context);

    expect(result).toMatchObject({
      definitionsCopied: 1,
      remappedDefinitions: 1,
      collectionRefsUpdated: 1
    });
    await expect(
      MongoDatasetCollectionTagsV2.collection.countDocuments({
        teamId: ids.teamId,
        datasetId: ids.datasetId,
        tag: 'safety'
      })
    ).resolves.toBe(1);
    const collection = await MongoDatasetCollection.collection.findOne({ _id: collectionId });
    expect(collection?.tags).toEqual([{ tagId: String(keptTagId), value: 'A' }]);
  });

  it('is idempotent across repeated runs', async () => {
    const ids = createIds();
    await seedDataset(ids);
    const tagId = new Types.ObjectId();
    await MongoDatasetCollectionTags.collection.insertOne({
      _id: tagId,
      teamId: ids.teamId,
      datasetId: ids.datasetId,
      tag: 'repeat'
    });

    await migrateLegacyCollectionTags(createContext().context);
    const second = await migrateLegacyCollectionTags(createContext().context);

    expect(second).toMatchObject({ definitionsCopied: 0, remappedDefinitions: 0 });
    await expect(MongoDatasetCollectionTagsV2.collection.countDocuments({})).resolves.toBe(1);
  });

  it('reports dangling collection references without deleting them', async () => {
    const ids = createIds();
    await seedDataset(ids);
    const missingTagId = new Types.ObjectId();
    const collectionId = (
      await seedCollection({ ...ids, tags: [{ tagId: String(missingTagId), value: 'x' }] })
    ).insertedId;

    const { context } = createContext();
    const result = await migrateLegacyCollectionTags(context);

    expect(result.danglingReferences).toBe(1);
    await expect(
      MongoDatasetCollection.collection.countDocuments({ _id: collectionId })
    ).resolves.toBe(1);
    expect(context.logger.warn).toHaveBeenCalled();
  });
});

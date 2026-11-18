import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetData } from '@fastgpt/service/core/dataset/data/schema';
import {
  MongoDatasetSynonym,
  MongoDatasetSynonymMapping
} from '@fastgpt/service/core/dataset/synonym/schema';
import {
  migrateDatasetFieldBatch,
  migrateDatasetSynonyms,
  migrateLegacySynonymData,
  readDatasetFieldBatch
} from '@/migration/tasks/4180/20261116_migrate_legacy_dataset/service';

describe('migrate legacy dataset', () => {
  const datasetIds: Types.ObjectId[] = [];
  const synonymConfigIds: Types.ObjectId[] = [];

  const synonymMappingIds: Types.ObjectId[] = [];
  const datasetDataIds: Types.ObjectId[] = [];

  beforeEach(() => {
    datasetIds.length = 0;
    synonymConfigIds.length = 0;
    synonymMappingIds.length = 0;
    datasetDataIds.length = 0;
  });

  afterEach(async () => {
    await Promise.all([
      datasetIds.length > 0
        ? MongoDataset.collection.deleteMany({ _id: { $in: datasetIds } })
        : Promise.resolve(),
      datasetDataIds.length > 0
        ? MongoDatasetData.collection.deleteMany({ _id: { $in: datasetDataIds } })
        : Promise.resolve(),
      synonymConfigIds.length > 0
        ? MongoDatasetSynonym.collection.deleteMany({ _id: { $in: synonymConfigIds } })
        : Promise.resolve(),
      synonymMappingIds.length > 0
        ? MongoDatasetSynonymMapping.collection.deleteMany({ _id: { $in: synonymMappingIds } })
        : Promise.resolve()
    ]);
  });

  it('migrates legacy parse switches into sangforFileParseConfig and removes old fields', async () => {
    const datasetId = new Types.ObjectId();
    datasetIds.push(datasetId);
    await MongoDataset.collection.insertOne({
      _id: datasetId,
      teamId: new Types.ObjectId(),
      tmbId: new Types.ObjectId(),
      type: 'dataset',
      name: 'legacy-parse-dataset',
      keep_header_footer: true,
      keep_appendix: false,
      image_analysis: true,
      updateTime: new Date()
    });

    const rows = await readDatasetFieldBatch({ lastId: null, limit: 1000 });
    const target = rows.find((row) => String(row._id) === String(datasetId));
    expect(target).toBeTruthy();

    await migrateDatasetFieldBatch([target!]);

    const updated = await MongoDataset.collection.findOne({ _id: datasetId });
    expect(updated?.sangforFileParseConfig).toEqual({
      keep_header_footer: true,
      keep_appendix: false,
      image_analysis: true,
      chart_analysis: false
    });
    expect(updated).not.toHaveProperty('keep_header_footer');
    expect(updated).not.toHaveProperty('keep_appendix');
    expect(updated).not.toHaveProperty('image_analysis');

    const nextRows = await readDatasetFieldBatch({ lastId: null, limit: 1000 });
    expect(nextRows.some((row) => String(row._id) === String(datasetId))).toBe(false);
  });

  it('upgrades legacy synonym configs and mappings to schema version 2', async () => {
    const teamId = new Types.ObjectId();
    const datasetId = new Types.ObjectId();
    const configId = new Types.ObjectId();
    synonymConfigIds.push(configId);
    const mappingId = new Types.ObjectId();
    synonymMappingIds.push(mappingId);

    await MongoDatasetSynonym.collection.insertOne({
      _id: configId,
      teamId,
      datasetId,
      fileName: 'synonym.csv',
      fileId: 'legacy/s3/key.csv',
      size: 100,
      uploadTime: new Date(),
      uploaderId: new Types.ObjectId()
    });
    await MongoDatasetSynonymMapping.collection.insertOne({
      _id: mappingId,
      teamId,
      datasetId,
      synonymFileId: configId,
      standardizedTerm: 'Fast GPT',
      synonymTerms: ['fastgpt', 'fast-gpt'],
      allTerms: 'Fast GPT fastgpt fast-gpt',
      createdTime: new Date('2026-01-01T00:00:00Z'),
      updatedTime: new Date('2026-01-02T00:00:00Z')
    });

    const result = await migrateDatasetSynonyms();
    expect(result.migrated).toBeGreaterThanOrEqual(1);

    const config = await MongoDatasetSynonym.collection.findOne({ _id: configId });
    expect(config).toMatchObject({
      schemaVersion: 2,
      version: 1,
      enabled: true
    });

    const mapping = await MongoDatasetSynonymMapping.collection.findOne({ _id: mappingId });
    expect(mapping).toMatchObject({
      logicalMappingId: mappingId,
      fileVersion: 1,
      normalizedStandardizedTerm: 'fast gpt',
      normalizedSynonymTerms: ['fastgpt', 'fast-gpt']
    });
    expect(typeof mapping?.fingerprint).toBe('string');
    expect(mapping?.createTime).toBeInstanceOf(Date);
    expect(mapping?.updateTime).toBeInstanceOf(Date);
  });

  it('disables migrated synonym config without mappings', async () => {
    const configId = new Types.ObjectId();
    synonymConfigIds.push(configId);
    await MongoDatasetSynonym.collection.insertOne({
      _id: configId,
      teamId: new Types.ObjectId(),
      datasetId: new Types.ObjectId(),
      fileName: 'empty.csv',
      fileId: 'legacy/s3/empty.csv',
      size: 0,
      uploadTime: new Date(),
      uploaderId: new Types.ObjectId()
    });

    await migrateDatasetSynonyms();

    const config = await MongoDatasetSynonym.collection.findOne({ _id: configId });
    expect(config).toMatchObject({ schemaVersion: 2, version: 1, enabled: false });
  });

  it('backfills data synonymVersion and removes legacy synonym markers', async () => {
    const teamId = new Types.ObjectId();
    const datasetId = new Types.ObjectId();
    const otherDatasetId = new Types.ObjectId();
    const configId = new Types.ObjectId();
    synonymConfigIds.push(configId);
    await MongoDatasetSynonym.collection.insertOne({
      _id: configId,
      teamId,
      datasetId,
      fileName: 'synonym.csv',
      fileId: 'legacy/s3/synonym.csv',
      size: 10,
      uploadTime: new Date(),
      uploaderId: new Types.ObjectId(),
      schemaVersion: 2,
      version: 1,
      enabled: true
    });

    const dataId = new Types.ObjectId();
    const otherDataId = new Types.ObjectId();
    datasetDataIds.push(dataId, otherDataId);
    await MongoDatasetData.collection.insertMany([
      {
        _id: dataId,
        teamId,
        datasetId,
        collectionId: new Types.ObjectId(),
        tmbId: new Types.ObjectId(),
        q: 'q',
        a: '',
        indexes: [],
        chunkIndex: 0,
        updateTime: new Date(),
        synonymFileIds: [String(configId)],
        synonymProcessing: 'standardize'
      },
      {
        _id: otherDataId,
        teamId,
        datasetId: otherDatasetId,
        collectionId: new Types.ObjectId(),
        tmbId: new Types.ObjectId(),
        q: 'q2',
        a: '',
        indexes: [],
        chunkIndex: 0,
        updateTime: new Date(),
        synonymFileIds: []
      }
    ]);

    const result = await migrateLegacySynonymData();
    expect(result.datasetsUpdated).toBeGreaterThanOrEqual(1);
    expect(result.datasVersioned).toBeGreaterThanOrEqual(1);

    const data = await MongoDatasetData.collection.findOne({ _id: dataId });
    expect(data?.synonymVersion).toBe(1);
    expect(data).not.toHaveProperty('synonymFileIds');
    expect(data).not.toHaveProperty('synonymProcessing');

    const other = await MongoDatasetData.collection.findOne({ _id: otherDataId });
    expect(other?.synonymVersion).toBeUndefined();
    expect(other).not.toHaveProperty('synonymFileIds');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelScopeEnum, ModelTypeEnum } from '@fastgpt/global/core/ai/constants';
import type { AIModelDocumentDataType } from '@fastgpt/global/core/ai/model/schema';
import { LegacySystemModelCollectionName } from '@fastgpt/service/core/ai/model/constants';
import {
  bootstrapAIModelsFromLegacy,
  inspectLegacySystemModelMigration
} from '@/migration/tasks/4170/20260903_migrate_legacy_system_models/service';
import { Types } from '@fastgpt/service/common/mongo';
import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import { MongoAIModel } from '@fastgpt/service/core/ai/model/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { MongoTeamMember } from '@fastgpt/service/support/user/team/teamMemberSchema';
import { MongoUser } from '@fastgpt/service/support/user/schema';
import { MongoModelStatusProbeRecord } from '@fastgpt/service/core/ai/modelStatus/schema';
import { MongoAIModelCatalog } from '@fastgpt/service/core/ai/model/catalog/schema';
import {
  getCachedSystemModelHandle,
  publishSystemModelHandle
} from '@fastgpt/service/core/ai/model/catalog/cache';
import {
  getSystemModelHandle,
  loadInstalledModels
} from '@fastgpt/service/core/ai/model/catalog/service';

// 本文件验证首次模型体系初始化的事务原子性，不能使用全局的无事务测试替身。
vi.unmock('@fastgpt/service/common/mongo/sessionRun');

const pluginLlm: AIModelDocumentDataType = {
  type: ModelTypeEnum.llm,
  provider: 'OpenAI',
  model: 'plugin-llm',
  name: 'Plugin LLM',
  scope: ModelScopeEnum.system,
  isActive: true,
  config: {
    maxContext: 128000,
    maxResponse: 32000,
    quoteMaxToken: 100000
  }
};

const createLegacyLlm = (model: string) => ({
  model,
  // 预置模型：150 落库时显式写入 isCustom: false
  isCustom: false,
  metadata: {
    type: ModelTypeEnum.llm,
    provider: 'OpenAI',
    name: model,
    maxContext: 32000,
    maxResponse: 16000,
    quoteMaxToken: 24000
  }
});

describe('bootstrapAIModelsFromLegacy', () => {
  const legacyCollection = MongoAIModel.db.collection(LegacySystemModelCollectionName);

  beforeEach(async () => {
    vi.restoreAllMocks();
    publishSystemModelHandle(undefined);
    await Promise.all([
      MongoAIModel.deleteMany({}),
      MongoAIModelCatalog.deleteMany({}),
      MongoTeamMember.deleteMany({}),
      MongoUser.deleteMany({}),
      legacyCollection.deleteMany({})
    ]);
  });

  it('keeps a fresh installation empty when no legacy models exist', async () => {
    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 0,
      targetCount: 0,
      migratedCount: 0
    });
    await expect(MongoAIModel.countDocuments()).resolves.toBe(0);
    await expect(MongoAIModelCatalog.findOne({ scope: 'system' }).lean()).resolves.toMatchObject({
      scope: 'system',
      defaultModelIds: {}
    });
  });

  it.each([0, 7])(
    'refreshes a follower startup snapshot after migration commits from revision %i',
    async (revision) => {
      if (revision > 0) {
        await MongoAIModelCatalog.create({ scope: 'system', catalogRevision: revision });
      }
      const legacy = await legacyCollection.insertOne({
        ...createLegacyLlm('legacy-follower-model'),
        isActive: true,
        isDefault: true
      });

      // 多节点启动时已加载空的新目录；0 同时覆盖尚无目录记录的首次升级。
      await loadInstalledModels();
      const followerStartupSnapshot = await getSystemModelHandle();
      expect(followerStartupSnapshot.revision).toBe(revision);
      expect(followerStartupSnapshot.getSystemModels()).toEqual([]);

      await bootstrapAIModelsFromLegacy({ pluginDocuments: [] });
      await loadInstalledModels();
      expect(await MongoAIModel.countDocuments()).toBe(1);
      expect(getCachedSystemModelHandle()?.getSystemModels()).toHaveLength(1);

      // 恢复另一节点的旧快照，只走正常读取入口，不能借用执行节点的主动重载。
      publishSystemModelHandle(followerStartupSnapshot);
      const followerHandle = await getSystemModelHandle();
      expect(followerHandle.getSystemModels()).toMatchObject([
        { modelId: String(legacy.insertedId), model: 'legacy-follower-model' }
      ]);
      expect(followerHandle.revision).toBe(revision + 1);
      expect(followerHandle.configuredDefaultModelIds).toEqual({
        llm: String(legacy.insertedId)
      });
      expect(followerHandle.getDefaultModelData(ModelTypeEnum.llm).modelId).toBe(
        String(legacy.insertedId)
      );
      expect(followerStartupSnapshot.getSystemModels()).toEqual([]);
    }
  );

  it('preserves an existing valid default while merging a legacy model', async () => {
    const existingModel = await MongoAIModel.create(pluginLlm);
    await MongoAIModelCatalog.create({
      scope: 'system',
      defaultModelIds: { llm: String(existingModel._id) }
    });
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('legacy-default-candidate'),
      isActive: true,
      isDefault: true
    });

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      targetCount: 2,
      migratedCount: 1
    });
    await expect(MongoAIModel.findById(existingModel._id)).resolves.not.toBeNull();
    await expect(MongoAIModel.findById(legacy.insertedId)).resolves.not.toBeNull();
    await expect(MongoAIModel.countDocuments()).resolves.toBe(2);
    await expect(MongoAIModelCatalog.findOne({ scope: 'system' }).lean()).resolves.toMatchObject({
      scope: 'system',
      defaultModelIds: { llm: String(existingModel._id) }
    });
  });

  it('migrates legacy default flags into the single system default record', async () => {
    const result = await legacyCollection.insertMany([
      {
        ...createLegacyLlm('legacy-default-llm'),
        isActive: true,
        isDefault: true,
        isDefaultDatasetTextModel: true,
        isDefaultChatTitleModel: true
      },
      {
        model: 'legacy-default-embedding',
        isCustom: false,
        isActive: true,
        metadata: {
          type: ModelTypeEnum.embedding,
          provider: 'OpenAI',
          name: 'Legacy embedding',
          defaultToken: 500,
          maxToken: 3000,
          weight: 100,
          isDefault: true
        }
      }
    ]);

    await bootstrapAIModelsFromLegacy({ pluginDocuments: [] });

    await expect(MongoAIModelCatalog.findOne({ scope: 'system' }).lean()).resolves.toMatchObject({
      scope: 'system',
      defaultModelIds: {
        llm: String(result.insertedIds[0]),
        embedding: String(result.insertedIds[1]),
        datasetTextLLM: String(result.insertedIds[0]),
        chatTitleLLM: String(result.insertedIds[0])
      }
    });
    const migratedModels = await MongoAIModel.collection.find({}).toArray();
    for (const model of migratedModels) {
      expect(model).not.toHaveProperty('isDefault');
      expect(model).not.toHaveProperty('isDefaultDatasetTextModel');
      expect(model).not.toHaveProperty('isDefaultChatTitleModel');
    }
  });

  it('keeps target-only models while inserting legacy-only models', async () => {
    await MongoAIModel.create(pluginLlm);
    const legacy = await legacyCollection.insertOne(createLegacyLlm('legacy-model'));

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      targetCount: 2,
      migratedCount: 1
    });
    await expect(MongoAIModel.countDocuments()).resolves.toBe(2);
    await expect(MongoAIModel.findById(legacy.insertedId)).resolves.not.toBeNull();
    await expect(MongoAIModel.exists({ model: pluginLlm.model })).resolves.not.toBeNull();
    await expect(MongoAIModelCatalog.exists({ scope: 'system' })).resolves.not.toBeNull();
  });

  it('keeps the later legacy record when model names are duplicated', async () => {
    const result = await legacyCollection.insertMany([
      {
        ...createLegacyLlm('duplicate-model'),
        metadata: {
          ...createLegacyLlm('duplicate-model').metadata,
          name: 'Older duplicate',
          maxContext: 32000
        }
      },
      {
        ...createLegacyLlm('duplicate-model'),
        metadata: {
          ...createLegacyLlm('duplicate-model').metadata,
          name: 'Newer duplicate',
          maxContext: 64000
        }
      }
    ]);

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 2,
      targetCount: 1,
      migratedCount: 1
    });
    await expect(MongoAIModel.countDocuments()).resolves.toBe(1);
    const migrated = await MongoAIModel.findOne({ model: 'duplicate-model' }).lean();
    expect(migrated).toMatchObject({
      name: 'Newer duplicate',
      config: { maxContext: 64000 }
    });
    expect(String(migrated?._id)).toBe(String(result.insertedIds[1]));
    await expect(legacyCollection.countDocuments()).resolves.toBe(2);
  });

  it('skips an invalid legacy record and keeps migrating the rest', async () => {
    await legacyCollection.insertMany([
      createLegacyLlm('valid-before-invalid'),
      { model: 'invalid-model', isCustom: false, metadata: { type: 'unknown' } }
    ]);

    await expect(
      bootstrapAIModelsFromLegacy({ pluginDocuments: [] })
    ).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 2,
      migratedCount: 1,
      invalidCount: 1
    });
    await expect(MongoAIModel.countDocuments()).resolves.toBe(1);
    await expect(legacyCollection.countDocuments()).resolves.toBe(2);
  });

  it('rolls back model and default changes when the merge fails', async () => {
    await MongoAIModel.create(pluginLlm);
    await legacyCollection.insertOne(createLegacyLlm('legacy-write-failure'));
    const writeError = new Error('simulated target initialization failure');
    vi.spyOn(MongoAIModel.collection, 'bulkWrite').mockRejectedValue(writeError);

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).rejects.toBe(writeError);
    await expect(MongoAIModel.countDocuments()).resolves.toBe(1);
    await expect(MongoAIModel.exists({ model: pluginLlm.model })).resolves.not.toBeNull();
    await expect(MongoAIModelCatalog.exists({ scope: 'system' })).resolves.toBeNull();
  });

  it('rolls back the revision and migrated models when the default write fails', async () => {
    await MongoAIModelCatalog.create({ scope: 'system', catalogRevision: 7 });
    await legacyCollection.insertOne(createLegacyLlm('legacy-default-write-failure'));
    const writeError = new Error('simulated default write failure');
    vi.spyOn(MongoAIModelCatalog, 'findOneAndUpdate').mockRejectedValueOnce(writeError);

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).rejects.toBe(writeError);
    await expect(MongoAIModel.countDocuments()).resolves.toBe(0);
    await expect(MongoAIModelCatalog.findOne({ scope: 'system' }).lean()).resolves.toMatchObject({
      catalogRevision: 7,
      defaultModelIds: {}
    });
    await expect(legacyCollection.countDocuments()).resolves.toBe(1);
  });

  it('repairs a damaged legacy model from its plugin template and preserves the old id', async () => {
    const legacy = await legacyCollection.insertOne({
      model: pluginLlm.model,
      metadata: {
        name: 'Legacy display name',
        maxContext: 'invalid'
      }
    });

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [pluginLlm] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      targetCount: 1,
      migratedCount: 1
    });
    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      model: pluginLlm.model,
      name: 'Legacy display name',
      provider: pluginLlm.provider,
      type: pluginLlm.type,
      config: pluginLlm.config
    });
  });

  it('writes only canonical fields while leaving the legacy snapshot unchanged', async () => {
    const legacyDocument = {
      model: 'mixed-legacy-model',
      isCustom: false,
      type: ModelTypeEnum.llm,
      provider: 'Top-level provider',
      name: 'Top-level name',
      isSystem: true,
      maxContext: 64000,
      maxResponse: 16000,
      quoteMaxToken: 24000,
      unknownLegacyField: 'keep only in legacy',
      metadata: {
        type: ModelTypeEnum.embedding,
        provider: 'Metadata provider',
        name: 'Metadata name',
        maxContext: 1
      }
    };
    const legacy = await legacyCollection.insertOne(legacyDocument);

    await bootstrapAIModelsFromLegacy({ pluginDocuments: [] });

    const migrated = await MongoAIModel.collection.findOne({ _id: legacy.insertedId });
    expect(migrated).toMatchObject({
      _id: legacy.insertedId,
      model: 'mixed-legacy-model',
      type: ModelTypeEnum.llm,
      provider: 'Top-level provider',
      name: 'Top-level name',
      scope: 'system',
      config: { maxContext: 64000, maxResponse: 16000, quoteMaxToken: 24000 }
    });
    expect(migrated).not.toHaveProperty('metadata');
    expect(migrated).not.toHaveProperty('isSystem');
    expect(migrated).not.toHaveProperty('maxContext');
    expect(migrated).not.toHaveProperty('unknownLegacyField');
    await expect(legacyCollection.findOne({ _id: legacy.insertedId })).resolves.toEqual({
      _id: legacy.insertedId,
      ...legacyDocument
    });
  });

  it('reapplies the latest legacy snapshot without duplicating a model', async () => {
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('repeatable-model'),
      metadata: {
        ...createLegacyLlm('repeatable-model').metadata,
        name: 'Legacy version 1'
      }
    });

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      targetCount: 1,
      migratedCount: 1
    });
    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      model: 'repeatable-model',
      name: 'Legacy version 1',
      config: { maxContext: 32000 }
    });

    await legacyCollection.updateOne(
      { _id: legacy.insertedId },
      {
        $set: {
          'metadata.name': 'Legacy version 2',
          'metadata.maxContext': 64000
        }
      }
    );
    await MongoAIModel.updateOne(
      { _id: legacy.insertedId },
      { $set: { name: 'Target changed again' } }
    );

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      targetCount: 1,
      migratedCount: 1
    });
    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      model: 'repeatable-model',
      name: 'Legacy version 2',
      config: { maxContext: 64000 }
    });
    await expect(MongoAIModel.countDocuments()).resolves.toBe(1);
  });

  it('keeps a same-name target id while replacing its fields with the legacy model', async () => {
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('same-name-model'),
      isActive: true
    });
    const conflictingTarget = await MongoAIModel.create({
      ...pluginLlm,
      model: 'same-name-model',
      name: 'Conflicting target'
    });
    const unrelatedTarget = await MongoAIModel.create({
      ...pluginLlm,
      model: 'unrelated-model',
      name: 'Unrelated target'
    });
    await MongoAIModelCatalog.create({
      scope: 'system',
      defaultModelIds: { llm: String(conflictingTarget._id) }
    });

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      targetCount: 2,
      migratedCount: 1
    });

    await expect(MongoAIModel.findById(conflictingTarget._id).lean()).resolves.toMatchObject({
      model: 'same-name-model',
      name: 'same-name-model',
      isActive: true,
      config: {
        maxContext: 32000,
        maxResponse: 16000,
        quoteMaxToken: 24000
      }
    });
    await expect(MongoAIModel.findById(legacy.insertedId)).resolves.toBeNull();
    await expect(MongoAIModel.findById(unrelatedTarget._id)).resolves.not.toBeNull();
    await expect(MongoAIModel.countDocuments()).resolves.toBe(2);
    await expect(MongoAIModelCatalog.findOne({ scope: 'system' }).lean()).resolves.toMatchObject({
      defaultModelIds: { llm: String(conflictingTarget._id) }
    });
  });

  it('replaces a same-name target with legacy metadata', async () => {
    const legacy = await legacyCollection.insertOne({
      model: 'same-name-embedding',
      isCustom: false,
      metadata: {
        type: ModelTypeEnum.embedding,
        provider: 'OpenAI',
        name: 'Legacy embedding',
        isActive: true,
        defaultToken: 500,
        maxToken: 3000,
        weight: 100
      }
    });
    const preinstalled = await MongoAIModel.create({
      type: ModelTypeEnum.embedding,
      provider: 'Plugin provider',
      model: 'same-name-embedding',
      name: 'Preinstalled embedding',
      scope: 'system',
      isActive: false,
      config: {
        defaultToken: 1000,
        maxToken: 8000,
        weight: 50
      }
    });

    await bootstrapAIModelsFromLegacy({ pluginDocuments: [] });

    await expect(MongoAIModel.findById(preinstalled._id).lean()).resolves.toMatchObject({
      model: 'same-name-embedding',
      provider: 'OpenAI',
      name: 'Legacy embedding',
      isActive: true,
      config: {
        defaultToken: 500,
        maxToken: 3000,
        weight: 100
      }
    });
    await expect(MongoAIModel.findById(legacy.insertedId)).resolves.toBeNull();
    await expect(MongoAIModel.countDocuments()).resolves.toBe(1);
  });

  it('replaces an active same-name target with the inactive legacy state', async () => {
    await legacyCollection.insertOne({
      ...createLegacyLlm('same-name-active-target'),
      metadata: {
        ...createLegacyLlm('same-name-active-target').metadata,
        isActive: false
      }
    });
    const target = await MongoAIModel.create({
      ...pluginLlm,
      model: 'same-name-active-target'
    });

    await bootstrapAIModelsFromLegacy({ pluginDocuments: [] });

    await expect(MongoAIModel.findById(target._id).lean()).resolves.toMatchObject({
      model: 'same-name-active-target',
      isActive: false
    });
  });

  it('replaces an invalid existing default with the resolved id of the legacy default', async () => {
    const existingModel = await MongoAIModel.create({
      ...pluginLlm,
      model: 'same-name-default',
      name: 'Existing model'
    });
    await MongoAIModelCatalog.create({
      scope: 'system',
      defaultModelIds: { llm: 'missing-model-id' }
    });
    await legacyCollection.insertOne({
      ...createLegacyLlm('same-name-default'),
      isActive: true,
      isDefault: true,
      isDefaultDatasetTextModel: true
    });

    await bootstrapAIModelsFromLegacy({ pluginDocuments: [] });

    await expect(MongoAIModelCatalog.findOne({ scope: 'system' }).lean()).resolves.toMatchObject({
      defaultModelIds: {
        llm: String(existingModel._id),
        datasetTextLLM: String(existingModel._id)
      }
    });
  });

  it('skips a legacy id collision without changing the unrelated target model', async () => {
    const legacy = await legacyCollection.insertOne(createLegacyLlm('legacy-id-conflict'));
    await MongoAIModel.create({
      _id: legacy.insertedId,
      ...pluginLlm,
      model: 'unrelated-target'
    });

    await expect(
      bootstrapAIModelsFromLegacy({ pluginDocuments: [] })
    ).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      migratedCount: 0
    });
    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      model: 'unrelated-target'
    });
    await expect(MongoAIModel.exists({ model: 'legacy-id-conflict' })).resolves.toBeNull();
  });

  it('rejects a legacy model whose type conflicts with its plugin template before writing', async () => {
    await legacyCollection.insertOne({
      model: pluginLlm.model,
      metadata: {
        type: ModelTypeEnum.embedding,
        provider: 'OpenAI',
        name: 'Conflicting embedding',
        defaultToken: 500,
        maxToken: 3000,
        weight: 100
      }
    });

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [pluginLlm] })).rejects.toThrow(
      'System model type does not match plugin template'
    );
    await expect(MongoAIModel.countDocuments()).resolves.toBe(0);
    await expect(MongoAIModelCatalog.exists({ scope: 'system' })).resolves.toBeNull();
  });

  it('reports only system scope target models in the migration inspection', async () => {
    await legacyCollection.insertOne(createLegacyLlm('legacy-model'));
    await MongoAIModel.collection.insertOne({
      ...pluginLlm,
      scope: 'team',
      teamId: 'team-id'
    });

    await expect(inspectLegacySystemModelMigration()).resolves.toEqual({
      sourceCount: 1,
      targetCount: 0
    });
  });

  it('reads the latest target snapshot inside the transaction and merges without deleting it', async () => {
    await legacyCollection.insertOne(createLegacyLlm('legacy-race-model'));
    const originalFind = legacyCollection.find.bind(legacyCollection);
    vi.spyOn(legacyCollection, 'find').mockImplementationOnce((...args) => {
      const cursor = originalFind(...args);
      const originalToArray = cursor.toArray.bind(cursor);
      vi.spyOn(cursor, 'toArray').mockImplementationOnce(async () => {
        const records = await originalToArray();
        await MongoAIModel.create({
          ...pluginLlm,
          model: 'concurrent-system-model',
          name: 'Concurrent system model'
        });
        return records;
      });
      return cursor;
    });

    await expect(bootstrapAIModelsFromLegacy({ pluginDocuments: [] })).resolves.toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      targetCount: 2,
      migratedCount: 1
    });
    await expect(
      MongoAIModel.findOne({ model: 'concurrent-system-model' })
    ).resolves.not.toBeNull();
    await expect(MongoAIModel.findOne({ model: 'legacy-race-model' })).resolves.not.toBeNull();
    await expect(MongoAIModelCatalog.exists({ scope: 'system' })).resolves.not.toBeNull();
  });

  it('deletes unused preset models together with ACLs and probe records', async () => {
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('unused-preset'),
      isActive: true
    });
    await MongoResourcePermission.collection.insertOne({
      teamId: new Types.ObjectId(),
      tmbId: new Types.ObjectId(),
      resourceType: PerResourceTypeEnum.model,
      resourceId: legacy.insertedId,
      permission: 4
    });
    await MongoModelStatusProbeRecord.collection.insertOne({
      modelId: String(legacy.insertedId),
      name: 'unused-preset',
      model: 'unused-preset',
      provider: 'OpenAI',
      type: 'llm',
      status: 'green',
      attempts: 1,
      startedAt: new Date(),
      requestStartedAt: new Date(),
      requestEndedAt: new Date()
    });

    const result = await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => new Set(['channel-placeholder']),
      resolveReferencedTokens: async () => new Set<string>()
    });

    expect(result).toMatchObject({
      status: 'migrated',
      sourceCount: 1,
      migratedCount: 1,
      removedCount: 1
    });
    expect(result.removedModels).toEqual(['unused-preset']);
    await expect(MongoAIModel.exists({ _id: legacy.insertedId })).resolves.toBeNull();
    await expect(
      MongoResourcePermission.countDocuments({ resourceId: legacy.insertedId })
    ).resolves.toBe(0);
    await expect(
      MongoModelStatusProbeRecord.countDocuments({ modelId: String(legacy.insertedId) })
    ).resolves.toBe(0);
  });

  it('skips cleanup when the AI Proxy channel list is empty', async () => {
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('unconfigured-preset'),
      isActive: true
    });

    const result = await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => new Set<string>(),
      resolveReferencedTokens: async () => new Set<string>()
    });

    expect(result.removedCount).toBe(0);
    await expect(MongoAIModel.exists({ _id: legacy.insertedId })).resolves.not.toBeNull();
    expect(result.warnings.some((item) => item.includes('channel list is empty'))).toBe(true);
  });

  it('keeps referenced, channel-bound, default and custom models', async () => {
    const referenced = await legacyCollection.insertOne({
      ...createLegacyLlm('referenced-model'),
      isActive: true
    });
    const channelModel = await legacyCollection.insertOne({
      ...createLegacyLlm('channel-model'),
      isActive: true
    });
    const defaultModel = await legacyCollection.insertOne({
      ...createLegacyLlm('default-model'),
      isActive: true,
      isDefault: true
    });
    const custom = await legacyCollection.insertOne({
      ...createLegacyLlm('custom-model'),
      isCustom: true,
      isShared: true,
      isActive: true
    });

    const result = await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => new Set(['channel-model']),
      resolveReferencedTokens: async () => new Set(['referenced-model'])
    });

    expect(result.removedCount).toBe(0);
    for (const id of [
      referenced.insertedId,
      channelModel.insertedId,
      defaultModel.insertedId,
      custom.insertedId
    ]) {
      await expect(MongoAIModel.exists({ _id: id })).resolves.not.toBeNull();
    }
  });

  it('keeps non-root private models in system scope and preserves their ACL', async () => {
    const teamId = new Types.ObjectId();
    const tmbId = new Types.ObjectId();
    // 150 的老成员记录可能没有 status；本规则不依赖成员状态。
    await MongoTeamMember.collection.insertOne({
      _id: tmbId,
      teamId,
      userId: new Types.ObjectId(),
      name: 'Legacy creator'
    });
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('member-private-llm'),
      isCustom: true,
      isShared: false,
      isActive: true,
      tmbId,
      teamId
    });
    await MongoResourcePermission.collection.insertMany([
      {
        teamId,
        tmbId,
        resourceType: PerResourceTypeEnum.model,
        resourceId: legacy.insertedId,
        permission: OwnerRoleVal
      },
      {
        teamId,
        tmbId: new Types.ObjectId(),
        resourceType: PerResourceTypeEnum.model,
        resourceId: legacy.insertedId,
        permission: 4
      }
    ]);

    const result = await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => undefined,
      resolveReferencedTokens: async () => undefined
    });

    expect(result).toMatchObject({ systemCount: 1, teamCount: 0 });
    const migrated = await MongoAIModel.findById(legacy.insertedId).lean();
    expect(migrated).toMatchObject({ scope: 'system', model: 'member-private-llm' });
    // 系统模型不再携带归属字段
    expect(migrated).not.toHaveProperty('tmbId');
    expect(migrated).not.toHaveProperty('teamId');
    // 私有模型的 ACL 原样保留，可见范围与 150 一致
    await expect(
      MongoResourcePermission.countDocuments({ resourceId: legacy.insertedId })
    ).resolves.toBe(2);
  });

  it('makes root private models public when only the owner ACL exists', async () => {
    const teamId = new Types.ObjectId();
    const rootUserId = new Types.ObjectId();
    const rootTmbId = new Types.ObjectId();
    await MongoUser.collection.insertOne({ _id: rootUserId, username: 'root' });
    await MongoTeamMember.collection.insertOne({
      _id: rootTmbId,
      teamId,
      userId: rootUserId,
      status: 'active',
      role: 'owner'
    });
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('root-private-llm'),
      isCustom: true,
      isShared: false,
      isActive: true,
      tmbId: rootTmbId,
      teamId
    });
    await MongoResourcePermission.collection.insertOne({
      teamId,
      tmbId: rootTmbId,
      resourceType: PerResourceTypeEnum.model,
      resourceId: legacy.insertedId,
      permission: OwnerRoleVal
    });

    await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => undefined,
      resolveReferencedTokens: async () => undefined
    });

    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      scope: 'system'
    });
    // 只有 root 一条 ACL：删除后恢复全员可见
    await expect(
      MongoResourcePermission.countDocuments({ resourceId: legacy.insertedId })
    ).resolves.toBe(0);
  });

  it('keeps collaborator ACLs for root private models', async () => {
    const teamId = new Types.ObjectId();
    const rootUserId = new Types.ObjectId();
    const rootTmbId = new Types.ObjectId();
    await MongoUser.collection.insertOne({ _id: rootUserId, username: 'root' });
    await MongoTeamMember.collection.insertOne({
      _id: rootTmbId,
      teamId,
      userId: rootUserId,
      status: 'active'
    });
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('root-private-with-collaborator'),
      isCustom: true,
      isShared: false,
      isActive: true,
      tmbId: rootTmbId,
      teamId
    });
    await MongoResourcePermission.collection.insertMany([
      {
        teamId,
        tmbId: rootTmbId,
        resourceType: PerResourceTypeEnum.model,
        resourceId: legacy.insertedId,
        permission: OwnerRoleVal
      },
      {
        teamId,
        tmbId: new Types.ObjectId(),
        resourceType: PerResourceTypeEnum.model,
        resourceId: legacy.insertedId,
        permission: 4
      }
    ]);

    await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => undefined,
      resolveReferencedTokens: async () => undefined
    });

    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      scope: 'system'
    });
    // 包含其他协作者时保持 150 的可见范围
    await expect(
      MongoResourcePermission.countDocuments({ resourceId: legacy.insertedId })
    ).resolves.toBe(2);
  });

  it('clears every ACL of a shared model to keep it visible to everyone', async () => {
    const teamId = new Types.ObjectId();
    const shared = await legacyCollection.insertOne({
      ...createLegacyLlm('shared-with-collaborator'),
      isCustom: true,
      isShared: true,
      isActive: true
    });
    await MongoResourcePermission.collection.insertMany([
      {
        teamId,
        tmbId: new Types.ObjectId(),
        resourceType: PerResourceTypeEnum.model,
        resourceId: shared.insertedId,
        permission: OwnerRoleVal
      },
      {
        teamId,
        tmbId: new Types.ObjectId(),
        resourceType: PerResourceTypeEnum.model,
        resourceId: shared.insertedId,
        permission: 4
      }
    ]);

    await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => undefined,
      resolveReferencedTokens: async () => undefined
    });

    await expect(
      MongoResourcePermission.countDocuments({ resourceId: shared.insertedId })
    ).resolves.toBe(0);
  });

  it('keeps a private model without creator info in system scope and preserves ACL', async () => {
    const teamId = new Types.ObjectId();
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('orphan-private'),
      isCustom: true,
      isShared: false,
      isActive: true
    });
    await MongoResourcePermission.collection.insertOne({
      teamId,
      tmbId: new Types.ObjectId(),
      resourceType: PerResourceTypeEnum.model,
      resourceId: legacy.insertedId,
      permission: OwnerRoleVal
    });

    const result = await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => undefined,
      resolveReferencedTokens: async () => undefined
    });

    expect(result).toMatchObject({ systemCount: 1, teamCount: 0, skippedCount: 0 });
    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      scope: 'system'
    });
    await expect(
      MongoResourcePermission.countDocuments({ resourceId: legacy.insertedId })
    ).resolves.toBe(1);
  });

  it('keeps a system default that points to a formerly private model', async () => {
    const teamId = new Types.ObjectId();
    const tmbId = new Types.ObjectId();
    await MongoTeamMember.collection.insertOne({
      _id: tmbId,
      teamId,
      userId: new Types.ObjectId(),
      status: 'active'
    });
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('private-default'),
      isCustom: true,
      isShared: false,
      isActive: true,
      tmbId,
      teamId
    });
    await MongoAIModel.create({
      _id: legacy.insertedId,
      type: ModelTypeEnum.llm,
      provider: 'OpenAI',
      model: 'private-default',
      name: 'private-default',
      scope: 'system',
      isActive: true,
      config: { maxContext: 32000, maxResponse: 16000, quoteMaxToken: 24000 }
    });
    await MongoAIModelCatalog.create({
      scope: 'system',
      defaultModelIds: { llm: String(legacy.insertedId) }
    });

    const result = await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => undefined,
      resolveReferencedTokens: async () => undefined
    });

    expect(result.clearedDefaultSlots).not.toContain('llm');
    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      scope: 'system'
    });
    const catalog = await MongoAIModelCatalog.findOne({ scope: 'system' }).lean();
    expect((catalog?.defaultModelIds as any)?.llm).toBe(String(legacy.insertedId));
  });

  it('keeps preset models in system scope even when isShared is false', async () => {
    const teamId = new Types.ObjectId();
    const tmbId = new Types.ObjectId();
    await MongoTeamMember.collection.insertOne({
      _id: tmbId,
      teamId,
      userId: new Types.ObjectId(),
      status: 'active'
    });
    const legacy = await legacyCollection.insertOne({
      ...createLegacyLlm('preset-with-owner'),
      isCustom: false,
      isShared: false,
      isActive: true,
      tmbId,
      teamId
    });

    const result = await bootstrapAIModelsFromLegacy({
      pluginDocuments: [],
      resolveChannelModels: async () => undefined,
      resolveReferencedTokens: async () => undefined
    });

    expect(result).toMatchObject({ teamCount: 0 });
    await expect(MongoAIModel.findById(legacy.insertedId).lean()).resolves.toMatchObject({
      scope: 'system'
    });
  });
});

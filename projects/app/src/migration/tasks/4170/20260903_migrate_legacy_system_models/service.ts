import { Types } from '@fastgpt/service/common/mongo';
import { ModelScopeEnum, ModelTypeEnum } from '@fastgpt/global/core/ai/constants';
import type { AIModelDocumentDataType } from '@fastgpt/global/core/ai/model/schema';
import {
  ModelDefaultIdsSchema,
  type ModelDefaultIds
} from '@fastgpt/global/core/ai/model/default';
import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import { MongoAIModel } from '@fastgpt/service/core/ai/model/schema';
import { LegacySystemModelCollectionName } from '@fastgpt/service/core/ai/model/constants';
import { MongoAIModelCatalog } from '@fastgpt/service/core/ai/model/catalog/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { MongoTeamMember } from '@fastgpt/service/support/user/team/teamMemberSchema';
import { MongoUser } from '@fastgpt/service/support/user/schema';
import { deleteModelRecords } from '@fastgpt/service/core/ai/model/cleanup';
import { MongoModelStatusProbeRecord } from '@fastgpt/service/core/ai/modelStatus/schema';
import { runModelTransaction } from '@fastgpt/service/core/ai/model/catalog/transaction';
import { upsertSystemDefaultModelIds } from '@fastgpt/service/core/ai/model/catalog/entity';
import {
  getLegacyDefaultModelFlags,
  getLegacyOwnerIds,
  getLegacyRequestCredentials,
  isLegacyTeamModel,
  repairSystemModelDocument,
  LegacyAIModelDocumentSchema,
  type LegacyAIModelDocumentType,
  type LegacyDefaultModelFlags
} from './utils';

export type BootstrapAIModelsResult = {
  status: 'migrated';
  sourceCount: number;
  /** 迁移后 ai_models 的实际记录数（system + team）。 */
  targetCount: number;
  /** 成功迁移的旧记录数，不扣除清理数量。 */
  migratedCount: number;
  systemCount: number;
  /** 本迁移不再写入团队模型，保留字段用于结果兼容。 */
  teamCount: number;
  removedCount: number;
  aclRemovedCount: number;
  invalidCount: number;
  /** 归属解析失败跳过数量；当前所有模型统一写 system，保留字段用于结果兼容。 */
  skippedCount: number;
  clearedDefaultSlots: string[];
  removedModels: string[];
  channelCheck: 'ok' | 'skipped';
  referenceCheck: 'ok' | 'skipped';
  warnings: string[];
};

type LegacyRecord = Record<string, unknown>;

type MigrationCandidate = {
  legacyId: unknown;
  legacyRecord: LegacyRecord;
  document: LegacyAIModelDocumentType;
  defaultFlags: LegacyDefaultModelFlags;
  order: number;
  /** 非 root 创建的私有模型：保留 150 的 ACL，维持原有可见范围。 */
  preserveAcl: boolean;
};

type AclRow = {
  _id: unknown;
  resourceId?: unknown;
  resourceName?: string;
  permission: number;
  groupId?: unknown;
  orgId?: unknown;
};

const REFERENCE_COLLECTIONS = [
  'apps',
  'app_versions',
  'app_templates',
  'datasets',
  'evals',
  'eval_items',
  'agent_skills',
  'agent_skills_versions'
];
const MAX_REFERENCE_DOCS = 200_000;
/** 引用扫描是启动阻塞步骤：超时则跳过清理（只报告），避免拖慢升级。 */
const MAX_REFERENCE_SCAN_MS = 60_000;

/** 把 unknown[] 归一成 Mongo `$in` 可用的 ObjectId[]（强类型，非法 id 忽略）。 */
const toObjectIdList = (ids: unknown[]): Types.ObjectId[] =>
  ids
    .filter((id): id is string | Types.ObjectId => typeof id === 'string' || id instanceof Types.ObjectId)
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

const defaultModelKeys = [
  ModelTypeEnum.llm,
  ModelTypeEnum.embedding,
  ModelTypeEnum.tts,
  ModelTypeEnum.stt,
  ModelTypeEnum.rerank,
  'datasetTextLLM',
  'datasetImageLLM',
  'chatTitleLLM'
] as const satisfies readonly (keyof ModelDefaultIds)[];

/**
 * 读取旧表与 system scope 新表数量。源记录数用于在空源场景跳过 Plugin 请求；
 * 目标记录数仅用于诊断，不决定任务是否执行。
 */
export const inspectLegacySystemModelMigration = async () => {
  const legacyCollection = MongoAIModel.db.collection(LegacySystemModelCollectionName);
  const [sourceCount, targetCount] = await Promise.all([
    legacyCollection.countDocuments(),
    MongoAIModel.countDocuments({ scope: ModelScopeEnum.system })
  ]);

  return { sourceCount, targetCount };
};

/** 最佳努力读取 AI Proxy 系统渠道绑定的模型名；失败时返回 undefined 并跳过清理。 */
const collectAiproxyChannelModels = async (): Promise<Set<string> | undefined> => {
  try {
    const { getAiproxyClientByScope } = await import('@fastgpt/service/core/ai/model/channel/client');
    const client = getAiproxyClientByScope({ channelType: 'system', tmbId: '' });
    const channels = (await client.channels.listAll()) as unknown as Array<{
      models?: string[];
      model_mapping?: Record<string, string>;
    }>;
    const models = new Set<string>();
    for (const channel of channels) {
      for (const model of channel.models ?? []) {
        if (typeof model === 'string' && model) models.add(model);
      }
      // 只在 model_mapping 中出现的模型同样由渠道提供，不能当成未使用。
      for (const mapped of Object.keys(channel.model_mapping ?? {})) models.add(mapped);
    }
    return models;
  } catch {
    return undefined;
  }
};

const walkStrings = (value: unknown, out: Set<string>): void => {
  if (typeof value === 'string') {
    if (value && value.length <= 512) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    if (value instanceof Types.ObjectId) {
      out.add(String(value));
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) walkStrings(item, out);
  }
};

/** 一次性扫描应用/知识库/评测数据中的字符串引用；无法在安全范围内完成时返回 undefined。 */
const collectReferencedModelTokens = async (): Promise<Set<string> | undefined> => {
  const db = MongoAIModel.db;
  const tokens = new Set<string>();
  const startedAt = Date.now();
  let scanned = 0;

  for (const collectionName of REFERENCE_COLLECTIONS) {
    let cursor;
    try {
      cursor = db.collection(collectionName).find({});
    } catch {
      continue;
    }
    for await (const doc of cursor) {
      scanned += 1;
      if (scanned > MAX_REFERENCE_DOCS) return undefined;
      if (scanned % 1000 === 0 && Date.now() - startedAt > MAX_REFERENCE_SCAN_MS) {
        return undefined;
      }
      walkStrings(doc, tokens);
    }
  }

  return tokens;
};

const isOwnerOnlyAcl = (rows: AclRow[]) =>
  rows.every((row) => row.permission === OwnerRoleVal && !row.groupId && !row.orgId);

/**
 * 将旧 system_models 合并到 ai_models 的 system scope，并用 ACL 保留 150 的可见范围。
 *
 * - 所有旧模型统一写入 system scope：160 的团队模型只能走成员私有渠道分组，
 *   而 150 的模型依赖系统渠道或自带 requestUrl，转为团队模型会导致无法调用；
 * - 非 root 创建的私有模型（isCustom 且 isShared 非 true）：保留原有 ACL，
 *   可见范围与 150 一致（创建人 + 协作者，团队管理者仍可见）；
 * - root 创建的私有模型：只有 owner ACL 时删除，恢复全员可见；包含协作人时保留 ACL；
 * - 公开自建模型（isShared=true）：清除 ACL，保持全员可见；
 * - 预置模型在无渠道、无 url/key、无引用且非默认时删除。
 *
 * 整体可幂等重放：模型按 _id upsert、清理按实时判据重算、ACL 删除与默认合并均为幂等操作。
 */
export const bootstrapAIModelsFromLegacy = async ({
  pluginDocuments,
  resolveChannelModels = collectAiproxyChannelModels,
  resolveReferencedTokens = collectReferencedModelTokens
}: {
  pluginDocuments: AIModelDocumentDataType[];
  /** 测试/调用方注入：渠道模型名集合；undefined 表示不可用，跳过清理。 */
  resolveChannelModels?: () => Promise<Set<string> | undefined>;
  /** 测试/调用方注入：被引用字符串集合；undefined 表示不可用，跳过清理。 */
  resolveReferencedTokens?: () => Promise<Set<string> | undefined>;
}): Promise<BootstrapAIModelsResult> => {
  const legacyCollection = MongoAIModel.db.collection(LegacySystemModelCollectionName);
  const records = (await legacyCollection
    .find({})
    .sort({ _id: 1 })
    .toArray()) as unknown as LegacyRecord[];
  const pluginMap = new Map(pluginDocuments.map((item) => [item.model, item]));
  const warnings: string[] = [];

  const systemByModel = new Map<string, MigrationCandidate>();
  /** root 的团队成员 id：用于区分 root 创建的私有模型与其他成员的私有模型。 */
  const rootUser = await MongoUser.findOne({ username: 'root' }).lean();
  const rootTmbIds = new Set(
    rootUser
      ? (await MongoTeamMember.find({ userId: rootUser._id }, { _id: 1 }).lean()).map((member) =>
          String(member._id)
        )
      : []
  );
  /** 同名去重时被丢弃的旧 _id：旧版本迁移可能已把它们写成 system scope，需要清理。 */
  const duplicateLegacyIds: unknown[] = [];
  let invalidCount = 0;

  for (const [order, record] of records.entries()) {
    const legacyId = record._id;
    const model = String(record.model ?? '');
    const ids = getLegacyOwnerIds(record);
    const isPrivateModel = isLegacyTeamModel(record, (name) => pluginMap.has(name));
    const creatorIsRoot = Boolean(ids.tmbId && rootTmbIds.has(ids.tmbId));

    const result = repairSystemModelDocument({
      record,
      pluginDocument: pluginMap.get(model),
      scope: ModelScopeEnum.system
    });

    if (result.status === 'invalid') {
      invalidCount += 1;
      warnings.push(`invalid legacy model: ${model} (${String(legacyId)})`);
      continue;
    }

    const candidate: MigrationCandidate = {
      legacyId,
      legacyRecord: record,
      document: result.document,
      defaultFlags: getLegacyDefaultModelFlags(record),
      order,
      // 非 root 创建的私有模型保留 150 的 ACL；其余模型沿用原有 ACL 归一规则。
      preserveAcl: isPrivateModel && !creatorIsRoot
    };

    // 历史上若同名模型被重复保存，以较新的记录为准，避免唯一索引阻断整次迁移。
    const previous = systemByModel.get(result.document.model);
    if (previous) {
      duplicateLegacyIds.push(previous.legacyId);
      warnings.push(
        `duplicate system model: ${result.document.model} (${String(previous.legacyId)} -> ${String(legacyId)})`
      );
    }
    systemByModel.set(result.document.model, candidate);
  }

  const systemCandidates = Array.from(systemByModel.values()).sort((a, b) => a.order - b.order);

  // AI Proxy 与引用扫描都是外部/全量读取，必须在事务外完成。
  // 没有旧模型时没有可清理的预置模型，跳过这两类扫描，避免全新 1.6 环境启动时
  // 白白遍历应用/知识库/评测集合以及请求 AI Proxy。
  const needsCleanupScan = systemCandidates.length > 0;
  const resolvedChannelModels = needsCleanupScan ? await resolveChannelModels() : undefined;
  // 空渠道列表无法区分“确实没有渠道”和“接口/权限异常”，按不可用处理，避免误删已配置模型。
  const channelModels =
    resolvedChannelModels && resolvedChannelModels.size > 0 ? resolvedChannelModels : undefined;
  if (needsCleanupScan && channelModels === undefined) {
    warnings.push('AI Proxy channel list is empty or unavailable; skip preset model cleanup');
  }
  const referencedTokens = needsCleanupScan ? await resolveReferencedTokens() : undefined;

  if (systemCandidates.length > 0) {
    const { assertSystemModelTypesMatchPluginTemplates } = await import(
      '@fastgpt/service/core/ai/model/transform'
    );
    assertSystemModelTypesMatchPluginTemplates({
      models: systemCandidates.map(({ document }) => document),
      pluginDocuments
    });
  }

  const clearedDefaultSlots: string[] = [];
  const removedModels: string[] = [];
  let removedCount = 0;
  let aclRemovedCount = 0;
  let systemCount = 0;

  // ACL 仅在本迁移中变更：事务外读取快照，避免大客户权限表进入事务。
  // 没有旧模型时 ACL 只参与候选归一/清理，无需全表读取。
  const aclRows = needsCleanupScan
    ? ((await MongoResourcePermission.collection
        .find({ resourceType: PerResourceTypeEnum.model })
        .toArray()) as unknown as AclRow[])
    : [];
  const aclById = new Map<string, AclRow[]>();
  const aclByName = new Map<string, AclRow[]>();
  for (const row of aclRows) {
    if (row.resourceId) {
      const key = String(row.resourceId);
      aclById.set(key, [...(aclById.get(key) ?? []), row]);
    } else if (row.resourceName) {
      aclByName.set(row.resourceName, [...(aclByName.get(row.resourceName) ?? []), row]);
    }
  }
  const systemTxWarnings: string[] = [];
  await runModelTransaction({ scope: ModelScopeEnum.system }, async (session) => {
    // 事务可能因 TransientTransactionError 重跑，回调内的计数与数组必须每次重置。
    systemCount = 0;
    removedCount = 0;
    aclRemovedCount = 0;
    clearedDefaultSlots.length = 0;
    removedModels.length = 0;
    systemTxWarnings.length = 0;

    const targetRecords = await MongoAIModel.collection
      .find({ scope: ModelScopeEnum.system }, { session })
      .toArray();
    const existingDefaultModel = await MongoAIModelCatalog.collection.findOne(
      { scope: ModelScopeEnum.system },
      { session }
    );
    const targetModels = targetRecords.map((record) => ({
      _id: record._id,
      document: LegacyAIModelDocumentSchema.parse(record)
    }));
    const targetByModel = new Map<string, (typeof targetModels)[number]>();
    const targetById = new Map(targetModels.map((model) => [String(model._id), model]));
    for (const targetModel of targetModels) {
      targetByModel.set(targetModel.document.model, targetModel);
    }
    // 旧版本迁移/人工操作可能已把同 _id 写成团队模型；避免 insert 冲突或误覆盖。
    const crossScopeTeamRecords = (
      systemCandidates.length === 0
        ? []
        : await MongoAIModel.collection
            .find(
              {
                _id: { $in: toObjectIdList(systemCandidates.map((candidate) => candidate.legacyId)) },
                scope: ModelScopeEnum.team
              },
              { projection: { _id: 1, model: 1 }, session }
            )
            .toArray()
    ) as Array<{ _id: unknown; model?: unknown }>;
    const crossScopeTeamById = new Map(
      crossScopeTeamRecords.map((record) => [String(record._id), record])
    );

    const resolvedCandidates = systemCandidates.flatMap((candidate) => {
      const sameModel = targetByModel.get(candidate.document.model);
      const resolvedId = sameModel?._id ?? candidate.legacyId;
      const crossScope = crossScopeTeamById.get(String(resolvedId));
      // 旧版本迁移可能已把同 _id 写成团队模型：同名时转回系统模型，异名跳过避免误覆盖。
      if (crossScope && String(crossScope.model) !== candidate.document.model) {
        systemTxWarnings.push(
          `system model id conflicts with team scope model: ${candidate.document.model} (${String(resolvedId)})`
        );
        return [];
      }
      const idConflict = targetById.get(String(resolvedId));
      if (!sameModel && idConflict && idConflict.document.model !== candidate.document.model) {
        systemTxWarnings.push(
          `system model id conflict: ${candidate.document.model} (${String(candidate.legacyId)})`
        );
        return [];
      }
      return [
        {
          _id: resolvedId,
          document: candidate.document,
          defaultFlags: candidate.defaultFlags,
          legacyId: candidate.legacyId,
          preserveAcl: candidate.preserveAcl,
          isPublicModel: candidate.legacyRecord.isShared === true,
          shouldInsert: !sameModel && !crossScope,
          // 同名目标或历史团队模型都按替换写入，重复执行可收敛到 system scope。
          shouldReplace: Boolean(sameModel) || Boolean(crossScope)
        }
      ];
    });

    if (resolvedCandidates.length > 0) {
      await MongoAIModel.collection.bulkWrite(
        [
          ...resolvedCandidates
            .filter(({ shouldInsert }) => shouldInsert)
            .map(({ _id, document }) => ({
              insertOne: { document: { ...document, _id } }
            })),
          ...resolvedCandidates
            .filter(({ shouldReplace }) => shouldReplace)
            .map(({ _id, document }) => ({
              replaceOne: { filter: { _id }, replacement: { ...document, _id } }
            }))
        ] as never,
        { ordered: true, session }
      );
    }
    systemCount = resolvedCandidates.length;

    // 旧版本迁移可能已把被去重的 _id 写成 system scope，这里一并清理，保证重复执行收敛。
    if (duplicateLegacyIds.length > 0) {
      await MongoAIModel.collection.deleteMany(
        { _id: { $in: toObjectIdList(duplicateLegacyIds) }, scope: ModelScopeEnum.system },
        { session }
      );
    }

    const finalSystemById = new Map(
      targetModels.map(({ _id, document }) => [String(_id), document])
    );
    resolvedCandidates.forEach(({ _id, document }) => {
      finalSystemById.set(String(_id), document);
    });

    // 默认模型只接受 system scope；指向团队模型的槽位会被过滤。
    const legacyDefaultModelIds: ModelDefaultIds = {};
    for (const { _id, document, defaultFlags } of resolvedCandidates) {
      if (!document.isActive) continue;
      const modelId = String(_id);
      if (defaultFlags.isDefault) legacyDefaultModelIds[document.type] = modelId;
      if (document.type !== ModelTypeEnum.llm) continue;
      if (defaultFlags.isDefaultDatasetTextModel) legacyDefaultModelIds.datasetTextLLM = modelId;
      if (defaultFlags.isDefaultDatasetImageModel) legacyDefaultModelIds.datasetImageLLM = modelId;
      if (defaultFlags.isDefaultChatTitleModel) legacyDefaultModelIds.chatTitleLLM = modelId;
    }

    const isValidDefaultModel = (key: keyof ModelDefaultIds, modelId: string) => {
      const model = finalSystemById.get(modelId);
      if (!model?.isActive) return false;
      if (key === 'datasetTextLLM' || key === 'chatTitleLLM') {
        return model.type === ModelTypeEnum.llm;
      }
      if (key === 'datasetImageLLM') {
        return model.type === ModelTypeEnum.llm && model.config.vision === true;
      }
      return model.type === key;
    };

    const existingDefaultModelIds = ModelDefaultIdsSchema.parse(
      existingDefaultModel?.defaultModelIds ?? {}
    );
    const mergedDefaultModelIds: ModelDefaultIds = { ...legacyDefaultModelIds };
    for (const key of defaultModelKeys) {
      const existingModelId = existingDefaultModelIds[key];
      if (existingModelId && isValidDefaultModel(key, existingModelId)) {
        mergedDefaultModelIds[key] = existingModelId;
      } else if (existingModelId) {
        clearedDefaultSlots.push(key);
      }
    }
    for (const key of Object.keys(legacyDefaultModelIds) as (keyof ModelDefaultIds)[]) {
      const modelId = mergedDefaultModelIds[key];
      if (modelId && !isValidDefaultModel(key, modelId)) {
        delete mergedDefaultModelIds[key];
        clearedDefaultSlots.push(key);
      }
    }

    // 清理：只处理本次真正落库的预置模型，且必须在渠道/引用信息完整时执行。
    const canCleanup = channelModels !== undefined && referencedTokens !== undefined;
    const cleanedCandidates: MigrationCandidate[] = [];
    const cleanupResolvedIds = new Set<string>();
    if (canCleanup) {
      const defaultModelIds = new Set(Object.values(mergedDefaultModelIds).filter(Boolean));
      const resolvedByLegacyId = new Map(
        resolvedCandidates.map((candidate) => [String(candidate.legacyId), String(candidate._id)])
      );
      for (const candidate of systemCandidates) {
        const document = candidate.document;
        const resolvedId = resolvedByLegacyId.get(String(candidate.legacyId));
        // 被 id 冲突/跨 scope 冲突跳过的候选不能进入清理，避免误删同 id 的其他模型。
        if (!resolvedId) continue;
        // 只清理预置模型；用户自建模型即使当前不可用也保留配置。
        if (candidate.legacyRecord.isCustom === true) continue;
        if (defaultModelIds.has(resolvedId) || defaultModelIds.has(String(candidate.legacyId))) {
          continue;
        }
        if (
          candidate.defaultFlags.isDefault ||
          candidate.defaultFlags.isDefaultDatasetTextModel ||
          candidate.defaultFlags.isDefaultDatasetImageModel ||
          candidate.defaultFlags.isDefaultChatTitleModel
        ) {
          continue;
        }

        const { requestUrl, requestAuth } = getLegacyRequestCredentials(candidate.legacyRecord);
        if (requestUrl || requestAuth) continue;
        if (channelModels!.has(document.model)) continue;
        if (
          referencedTokens!.has(document.model) ||
          referencedTokens!.has(document.name) ||
          referencedTokens!.has(String(candidate.legacyId)) ||
          referencedTokens!.has(resolvedId)
        ) {
          continue;
        }

        cleanedCandidates.push(candidate);
        cleanupResolvedIds.add(resolvedId);
        removedModels.push(document.model);
      }
    }

    if (cleanupResolvedIds.size > 0) {
      const cleanupIdList = Array.from(cleanupResolvedIds);
      // 先统计实际存在的记录数；字符串 id 由 Mongoose 转换为 ObjectId。
      removedCount = await MongoAIModel.countDocuments({
        _id: { $in: cleanupIdList },
        scope: ModelScopeEnum.system
      }).session(session);
      // 统一删除契约：模型 + 跨团队 ACL + 探测记录，避免留下孤儿数据。
      await deleteModelRecords(cleanupIdList, session);
      cleanupResolvedIds.forEach((id) => finalSystemById.delete(id));
    }

    // 被同名去重丢弃的旧模型可能残留文档、ACL、探测记录。
    if (duplicateLegacyIds.length > 0) {
      await MongoAIModel.collection.deleteMany(
        { _id: { $in: toObjectIdList(duplicateLegacyIds) }, scope: ModelScopeEnum.system },
        { session }
      );
      await MongoModelStatusProbeRecord.deleteMany(
        { modelId: { $in: duplicateLegacyIds.map((id) => String(id)) } },
        { session }
      );
    }

    // ACL 归一（可见范围与 150 对齐）：
    // - 非 root 创建的私有模型：保留 ACL，创建人/协作者可见；
    // - 公开自建模型（isShared=true）：清除全部 ACL，保持全员可见；
    // - 预置模型与 root 私有模型：只有 owner ACL 时删除，其余情况保留。
    const aclDeleteIds = new Set<string>();
    const addAclRows = (rows: AclRow[]) => {
      for (const row of rows) aclDeleteIds.add(String(row._id));
    };
    // 保留 ACL 的私有模型名称：按名称清理极老 ACL 时不能误伤它们。
    const preservedAclNames = new Set(
      resolvedCandidates
        .filter((candidate) => candidate.preserveAcl)
        .flatMap((candidate) => [candidate.document.model, candidate.document.name])
    );
    // deleteModelRecords 只按 resourceId 清理；补充处理仅有 resourceName 的极老 ACL 行。
    for (const candidate of cleanedCandidates) {
      for (const name of [candidate.document.model, candidate.document.name]) {
        if (preservedAclNames.has(name)) continue;
        addAclRows(aclByName.get(name) ?? []);
      }
    }
    const collectModelAclRows = (resourceId: string, modelName: string, displayName: string) => [
      ...(aclById.get(resourceId) ?? []),
      ...(aclByName.get(modelName) ?? []),
      ...(aclByName.get(displayName) ?? [])
    ];
    for (const { _id, document, preserveAcl, isPublicModel } of resolvedCandidates) {
      if (preserveAcl) continue;
      const rows = collectModelAclRows(String(_id), document.model, document.name);
      if (isPublicModel || (rows.length > 0 && isOwnerOnlyAcl(rows))) {
        addAclRows(rows);
      }
    }
    // 被同名去重丢弃的旧模型可能残留 ACL，一并清理，避免悬空权限。
    for (const legacyId of duplicateLegacyIds) {
      for (const row of aclById.get(String(legacyId)) ?? []) {
        aclDeleteIds.add(String(row._id));
      }
    }
    if (aclDeleteIds.size > 0) {
      const ids = Array.from(aclDeleteIds)
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (ids.length > 0) {
        const result = await MongoResourcePermission.collection.deleteMany(
          { _id: { $in: ids } },
          { session }
        );
        aclRemovedCount = result.deletedCount;
      }
    }

    // 清理完成后再校验并写入默认槽位，保证不会指向已删除的模型。
    for (const key of defaultModelKeys) {
      const modelId = mergedDefaultModelIds[key];
      if (modelId && !isValidDefaultModel(key, modelId)) {
        delete mergedDefaultModelIds[key];
        clearedDefaultSlots.push(key);
      }
    }
    await upsertSystemDefaultModelIds(mergedDefaultModelIds, session);
  });
  warnings.push(...systemTxWarnings);

  const [finalSystemCount, finalTeamCount] = await Promise.all([
    MongoAIModel.countDocuments({ scope: ModelScopeEnum.system }),
    MongoAIModel.countDocuments({ scope: ModelScopeEnum.team })
  ]);

  return {
    status: 'migrated',
    sourceCount: records.length,
    // 迁移后 ai_models 的实际规模，避免与迁移条数混淆。
    targetCount: finalSystemCount + finalTeamCount,
    migratedCount: systemCount,
    systemCount,
    // 本迁移只写 system；已存在的团队模型（历史数据）不计入迁移结果。
    teamCount: 0,
    removedCount,
    aclRemovedCount,
    invalidCount,
    skippedCount: 0,
    clearedDefaultSlots: [...new Set(clearedDefaultSlots)],
    removedModels: [...new Set(removedModels)],
    channelCheck: channelModels === undefined ? 'skipped' : 'ok',
    referenceCheck: referencedTokens === undefined ? 'skipped' : 'ok',
    warnings: [...new Set(warnings)].slice(0, 200)
  };
};

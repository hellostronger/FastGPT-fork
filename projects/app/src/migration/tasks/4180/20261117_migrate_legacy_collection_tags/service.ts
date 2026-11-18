import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTagTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoDatasetCollectionTags } from '@fastgpt/service/core/dataset/tag/schema';
import { MongoDatasetCollectionTagsV2 } from '@fastgpt/service/core/dataset/tag/schemaV2';

export type LegacyCollectionTagRow = {
  _id: Types.ObjectId;
  teamId?: unknown;
  datasetId?: unknown;
  tag?: unknown;
  tagType?: unknown;
};

export type LegacyCollectionTagBatchResult = {
  /** 按原 _id 复制到 v2 的定义数量。 */
  copied: number;
  /** 同名定义已存在、仅改写 collection 引用数量的定义数量。 */
  remapped: number;
  /** 因同名去重而改写了 tagId 的 collection 数量。 */
  collectionRefsUpdated: number;
  /** 缺少 teamId/datasetId/tag 的无效定义数量。 */
  invalid: number;
};

const tagTypeValues = new Set<string>(Object.values(DatasetCollectionTagTypeEnum));

/** 150 的 tagType 只有 string/number/datetime，160 全部兼容；非法值回退 string。 */
export const normalizeLegacyTagType = (value: unknown): DatasetCollectionTagTypeEnum => {
  const text = typeof value === 'string' ? value : '';
  return (tagTypeValues.has(text)
    ? text
    : DatasetCollectionTagTypeEnum.string) as DatasetCollectionTagTypeEnum;
};

/** 旧标签定义的扫描窗口：固定 _id 上界，避免迁移期间新增定义导致无限扫描。 */
export const getLegacyCollectionTagSnapshot = async () => {
  const collection = MongoDatasetCollectionTags.collection;
  const [total, last] = await Promise.all([
    collection.countDocuments({}),
    collection
      .find({}, { projection: { _id: 1 } })
      .sort({ _id: -1 })
      .limit(1)
      .toArray()
  ]);
  return { total, endId: (last[0]?._id as Types.ObjectId | undefined) ?? undefined };
};

export const readLegacyCollectionTagBatch = async ({
  lastId,
  endId,
  limit
}: {
  lastId: Types.ObjectId | null;
  endId: Types.ObjectId;
  limit: number;
}): Promise<LegacyCollectionTagRow[]> => {
  const idFilter: { $gt?: Types.ObjectId; $lte: Types.ObjectId } = { $lte: endId };
  if (lastId) idFilter.$gt = lastId;
  return (await MongoDatasetCollectionTags.collection
    .find({ _id: idFilter })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray()) as unknown as LegacyCollectionTagRow[];
};

/** 同名定义去重后，把 collection 中指向旧 id 的 tagId 改到保留的 v2 id。 */
const rewriteCollectionTagReferences = async ({
  teamId,
  datasetId,
  oldId,
  newId
}: {
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  oldId: string;
  newId: string;
}) => {
  const cursor = MongoDatasetCollection.collection.find(
    { teamId, datasetId, 'tags.tagId': oldId },
    { projection: { tags: 1 } }
  );

  let updated = 0;
  for await (const collection of cursor) {
    const tags = Array.isArray(collection.tags)
      ? (collection.tags as Array<Record<string, unknown>>)
      : [];
    let changed = false;
    const nextTags = tags.map((tag) => {
      if (!tag || typeof tag !== 'object') return tag;
      if (String(tag.tagId ?? '') !== oldId) return tag;
      changed = true;
      return { ...tag, tagId: newId };
    });
    if (!changed) continue;

    // 用原 tags 做并发保护：期间被修改则本次不覆盖。
    const result = await MongoDatasetCollection.collection.updateOne(
      { _id: collection._id, tags: collection.tags as never },
      { $set: { tags: nextTags } }
    );
    if (result.modifiedCount > 0) updated += 1;
  }

  return updated;
};

/**
 * 把 150 的 `dataset_collection_tags` 定义按原 `_id` 复制到 `dataset_collection_tags_v2`。
 *
 * 150 的 collection 以 `tags: [{ tagId: "<v1 _id>", value }]` 引用定义，保留 `_id` 后
 * collection 字段无需改写；只有同名定义重复（v1 无唯一索引）时才把引用改到保留的 id。
 * 复制出的定义不能标记 `fromMigration`，该字段只用于标识 default_tag 承载记录。
 */
export const migrateLegacyCollectionTagBatch = async ({
  docs
}: {
  docs: LegacyCollectionTagRow[];
}): Promise<LegacyCollectionTagBatchResult> => {
  const v2 = MongoDatasetCollectionTagsV2.collection;
  const result: LegacyCollectionTagBatchResult = {
    copied: 0,
    remapped: 0,
    collectionRefsUpdated: 0,
    invalid: 0
  };

  for (const doc of docs) {
    const tag = typeof doc.tag === 'string' ? doc.tag.trim() : '';
    const teamIdText = String(doc.teamId ?? '');
    const datasetIdText = String(doc.datasetId ?? '');
    if (
      !tag ||
      !Types.ObjectId.isValid(teamIdText) ||
      !Types.ObjectId.isValid(datasetIdText)
    ) {
      result.invalid += 1;
      continue;
    }
    const teamId = new Types.ObjectId(teamIdText);
    const datasetId = new Types.ObjectId(datasetIdText);

    const existingById = await v2.findOne({ _id: doc._id }, { projection: { _id: 1 } });
    if (existingById) continue;

    const nameFilter = { teamId, datasetId, tag };
    let target = await v2.findOne(nameFilter, { projection: { _id: 1 } });
    if (!target) {
      try {
        await v2.insertOne({
          _id: doc._id,
          teamId,
          datasetId,
          tag,
          tagType: normalizeLegacyTagType(doc.tagType),
          // 承载记录身份只由 fromMigration 标识，普通标签必须为 false。
          fromMigration: false
        });
        result.copied += 1;
        continue;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        // 并发写入同名定义：回查后转为改写引用。
        target = await v2.findOne(nameFilter, { projection: { _id: 1 } });
        if (!target) throw error;
      }
    }

    const oldId = String(doc._id);
    const newId = String(target._id);
    if (oldId !== newId) {
      result.collectionRefsUpdated += await rewriteCollectionTagReferences({
        teamId,
        datasetId,
        oldId,
        newId
      });
    }
    result.remapped += 1;
  }

  return result;
};

/** 统计 collection 中指向不存在 v2 定义的 tagId 数量（历史悬空引用，仅告警不阻断）。 */
export const countDanglingTagReferences = async () => {
  const referenced = await MongoDatasetCollection.collection
    .aggregate([
      { $match: { tags: { $exists: true, $ne: [] } } },
      { $unwind: '$tags' },
      { $match: { 'tags.tagId': { $type: 'string' } } },
      { $group: { _id: '$tags.tagId' } }
    ])
    .toArray();
  if (referenced.length === 0) return 0;

  const referencedIds = referenced.map((item) => String(item._id));
  const validObjectIds = referencedIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const existing = validObjectIds.length
    ? await MongoDatasetCollectionTagsV2.collection
        .find({ _id: { $in: validObjectIds } }, { projection: { _id: 1 } })
        .toArray()
    : [];
  const existingIds = new Set(existing.map((item) => String(item._id)));

  return referencedIds.filter((id) => !existingIds.has(id)).length;
};

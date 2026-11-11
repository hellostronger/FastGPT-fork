import './mocks';

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath, sep } from 'node:path';
import { connectMongo } from '@fastgpt/service/common/mongo/init';
import { initGlobalVariables } from '@/service/common/system';
import { afterAll, beforeAll, beforeEach, inject, onTestFinished, vi } from 'vitest';
import setupModels from './setupModels';
import { clean } from './datas/users';
import { connectionLogMongo, connectionMongo } from '@fastgpt/service/common/mongo';
import { loadVectorDBEnv } from './utils/env';
import type { Mongoose } from '@fastgpt/service/common/mongo';

/**
 * zod 解析守卫：`packages/*` 的 schema 必须由 FastGPT 工作区内的 zod 构建。
 *
 * 安装不完整（或依赖被提升到外层目录）时，zod 会沿目录向上回退到外层仓库的版本
 * （本项目验证环境里是 4.4.3）。两份 zod 副本会让 globalRegistry / instanceof
 * 跨副本失效：`.meta()` 读不到（zod-openapi 报 “missing .meta({ param })”）、
 * z.any() 等语义随副本漂移，表现为「并行偶发红、串行全绿」。
 *
 * 这里只断言解析位置（落在 FastGPT 工作区内的 .pnpm/zod@ 目录），不绑定版本号，
 * 后续升级 zod 不会误伤；失败时打印实际路径与版本，便于定位安装问题。
 */
const setupRequire = createRequire(import.meta.url);
const fastgptRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const globalPackageDir = resolvePath(fastgptRoot, 'packages/global');

const zodEntry = setupRequire.resolve('zod', { paths: [globalPackageDir] });
const zodPkg = setupRequire.resolve('zod/package.json', { paths: [globalPackageDir] });
const zodVersion = setupRequire(zodPkg).version as string;

if (!zodEntry.startsWith(`${fastgptRoot}${sep}`) || !zodEntry.includes('.pnpm/zod@')) {
  throw new Error(
    `[test-setup] zod resolved outside the FastGPT workspace: ${zodEntry} ` +
      `(version ${zodVersion}); expected under ${fastgptRoot}${sep}node_modules/.pnpm/zod@` +
      ` — run pnpm install in the FastGPT workspace`
  );
}

vi.stubEnv('NODE_ENV', 'test');

loadVectorDBEnv({ envFileNames: ['.env.test.local'] });

/**
 * Clears documents while keeping collections and indexes warm inside one test file.
 * File-level DB names are already isolated, so per-case cleanup does not need to
 * drop the whole database and force MongoDB to rebuild collection metadata.
 */
const clearMongoCollections = async (db: Mongoose | undefined) => {
  const database = db?.connection.db;
  if (!database) return;

  const collections = await database.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
};

beforeAll(async () => {
  vi.stubEnv('MONGODB_URI', inject('MONGODB_URI'));
  await connectMongo({ db: connectionMongo, url: inject('MONGODB_URI') });
  await connectMongo({ db: connectionLogMongo, url: inject('MONGODB_URI') });

  initGlobalVariables();
  global.agentUserTmbIds = new Set();
  global.systemEnv = {} as any;

  global.feConfigs = {
    limit: { uploadFileMaxAmount: 1000, uploadFileMaxSize: 1000 },
    isPlus: false
  } as any;
  await setupModels();
});

afterAll(async () => {
  await connectionMongo?.connection.db?.dropDatabase();
  await connectionLogMongo?.connection.db?.dropDatabase();
  await connectionMongo?.disconnect();
  await connectionLogMongo?.disconnect();
});

beforeEach(async () => {
  global.agentUserTmbIds = global.agentUserTmbIds ?? new Set();
  // await connectMongo({ db: connectionMongo, url: inject('MONGODB_URI') });
  // await connectMongo({ db: connectionLogMongo, url: inject('MONGODB_URI') });

  onTestFinished(async () => {
    clean();

    try {
      await Promise.all([
        clearMongoCollections(connectionMongo),
        clearMongoCollections(connectionLogMongo)
      ]);
    } catch (error) {
      // Ignore errors during cleanup
      console.warn('Error during test cleanup:', error);
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  isDisableSuperAdmin,
  isSuperAdminBypassDisabled
} from '@fastgpt/service/support/permission/dataset/disableSuperAdmin';
import { setDisableApiDatasetSuperAdmin } from '@test/utils/serviceEnv';

const managedApiDatasetServer = {
  apiServer: { baseUrl: 'https://api.example.com' },
  permissionSync: true
};
const unmanagedApiDatasetServer = { apiServer: { baseUrl: 'https://api.example.com' } };

afterEach(() => {
  setDisableApiDatasetSuperAdmin(false);
});

describe('isDisableSuperAdmin', () => {
  it('开关关闭时全部保留超管旁路', () => {
    expect(isSuperAdminBypassDisabled()).toBe(false);
    expect(isDisableSuperAdmin(managedApiDatasetServer)).toBe(false);
    expect(isDisableSuperAdmin(unmanagedApiDatasetServer)).toBe(false);
    expect(isDisableSuperAdmin()).toBe(false);
  });

  it('开关打开后只对开启权限同步的托管库生效', () => {
    setDisableApiDatasetSuperAdmin(true);
    expect(isSuperAdminBypassDisabled()).toBe(true);
    expect(isDisableSuperAdmin(managedApiDatasetServer)).toBe(true);
    // 未开权限同步的 API 文件库仍由站内管理，保留超管旁路
    expect(isDisableSuperAdmin(unmanagedApiDatasetServer)).toBe(false);
    // 普通知识库没有 apiDatasetServer，部署开关不收紧它们的超管旁路
    expect(isDisableSuperAdmin()).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import enChat from '@fastgpt/web/i18n/en/chat.json';
import zhCNChat from '@fastgpt/web/i18n/zh-CN/chat.json';
import { apiI18n } from '@/service/common/i18n';
import {
  translateApiMessage,
  translateApiMessageWithDefaultLocale
} from '@fastgpt/service/common/i18n/request';

const NOTICE_KEY = 'chat:agent_run_failed_notice';

/**
 * 生产入口（`NextAPI` 与 `instrumentation-node`）都通过这个单例注册 i18n。
 * 用例不自行调用 `createApiI18n`，只依赖应用侧单例，才能证明「生产入口确实注册了」。
 */
describe('app api i18n registration', () => {
  it('resolves i18n keys on background paths without a request context', async () => {
    // 渠道回调/定时任务没有 AsyncLocalStorage 上下文，只能走默认语言工厂。
    await expect(translateApiMessageWithDefaultLocale(NOTICE_KEY)).resolves.toBe(
      enChat.agent_run_failed_notice
    );
  });

  it('binds the request language for handlers wrapped by the API entry', async () => {
    const req = { headers: { 'x-fastgpt-language': 'zh-CN' } } as Parameters<
      typeof apiI18n
    >[0]['req'];
    const res = {} as Parameters<typeof apiI18n>[0]['res'];

    await apiI18n({ req, res }, async () => {
      // handler 内部：按本轮语言解析 key。
      expect(translateApiMessage(NOTICE_KEY)).toBe(zhCNChat.agent_run_failed_notice);
      // 带冒号的普通文案不是 key，必须原样保留（不能被当成未解析 key 丢弃）。
      expect(translateApiMessage('Failed: upstream timeout')).toBe('Failed: upstream timeout');
    });
  });
});

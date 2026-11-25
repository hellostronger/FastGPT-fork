import { beforeAll, describe, expect, it } from 'vitest';
import enCommon from '@fastgpt/web/i18n/en/common.json';
import enChat from '@fastgpt/web/i18n/en/chat.json';
import zhCNChat from '@fastgpt/web/i18n/zh-CN/chat.json';
import { generatedLoaders } from '@fastgpt/web/i18n/resourceLoaders.generated';
import {
  createApiI18n,
  isApiI18nKey,
  translateApiMessage,
  translateApiMessageWithDefaultLocale
} from '@fastgpt/service/common/i18n/request';
import type { NodeApiRequest, NodeApiResponse } from '@fastgpt/service/types/http';

/** 只承载请求语言的 HTTP 边界；res 用于绑定异步回调的翻译上下文。 */
const httpObjects = (locale: string) => {
  const req = { headers: { 'x-fastgpt-language': locale } } as NodeApiRequest;
  const res = {} as NodeApiResponse;
  return { req, res };
};

const withI18n = createApiI18n(generatedLoaders);

beforeAll(() => {
  // 生产入口在启动时就会创建该单例；这里显式创建以模拟同一注册顺序。
  void withI18n;
});

describe('isApiI18nKey', () => {
  it('accepts only namespaces that the app actually injects', () => {
    expect(isApiI18nKey('chat:agent_run_failed_notice')).toBe(true);
    expect(isApiI18nKey('common:code_error.sandbox_error.agent_sandbox_limit_reached')).toBe(true);
    // 形如 key 但 namespace 不存在：不能当成可翻译 key。
    expect(isApiI18nKey('not_a_namespace:some.key')).toBe(false);
    // 带冒号的普通文案（上游报错、URL、时间戳）同样不是 key。
    expect(isApiI18nKey('Failed: upstream timeout')).toBe(false);
    expect(isApiI18nKey('http://10.0.0.12:6443 is unreachable')).toBe(false);
    expect(isApiI18nKey('chat:')).toBe(false);
    expect(isApiI18nKey('plain text')).toBe(false);
  });

  it('translates keys for the request locale and leaves plain text untouched', async () => {
    const { req, res } = httpObjects('zh-CN');

    await withI18n({ req, res }, async () => {
      expect(translateApiMessage('chat:agent_run_failed_notice')).toBe(
        zhCNChat.agent_run_failed_notice
      );
      // 冒号文案不会被送进 i18next（不会命中任何 namespace）。
      expect(translateApiMessage('Failed: upstream timeout')).toBe('Failed: upstream timeout');
    });
  });
});

describe('createServerTranslator resource fallbacks', () => {
  it('skips namespaces missing for the request locale and falls back to en', async () => {
    // zh-CN 只注入 chat；请求语言缺 common 时不能抛错，应由 en 兜底。
    const partialLoaders = {
      en: {
        common: () => import('@fastgpt/web/i18n/en/common.json'),
        chat: () => import('@fastgpt/web/i18n/en/chat.json')
      },
      'zh-CN': {
        chat: () => import('@fastgpt/web/i18n/zh-CN/chat.json')
      }
    } as Parameters<typeof createApiI18n>[0];
    const partialI18n = createApiI18n(partialLoaders);
    const { req, res } = httpObjects('zh-CN');

    await partialI18n({ req, res }, async () => {
      // 缺失 namespace 的 key 回退英文，而不是抛错或返回空串。
      expect(translateApiMessage('common:code_error.sandbox_error.agent_sandbox_limit_reached')).toBe(
        enCommon['code_error.sandbox_error.agent_sandbox_limit_reached']
      );
      // 已注入的 namespace 仍按请求语言解析。
      expect(translateApiMessage('chat:agent_run_failed_notice')).toBe(
        zhCNChat.agent_run_failed_notice
      );
    });
  });

  it('does not throw when the default language resources are absent', async () => {
    // 完全不注入 en：后台默认语言路径只能原样返回 key，不能让调用方崩溃。
    const noDefaultLoaders = {
      'zh-CN': {
        chat: () => import('@fastgpt/web/i18n/zh-CN/chat.json')
      }
    } as Parameters<typeof createApiI18n>[0];
    const noDefaultI18n = createApiI18n(noDefaultLoaders);
    const { req, res } = httpObjects('zh-CN');

    await noDefaultI18n({ req, res }, async () => {
      expect(translateApiMessage('chat:agent_run_failed_notice')).toBe(
        zhCNChat.agent_run_failed_notice
      );
    });
    await expect(translateApiMessageWithDefaultLocale('chat:nonexistent_key')).resolves.toBe(
      'chat:nonexistent_key'
    );
    // 保留 enChat 引用，确保夹具只承载「缺 en」这一种差异。
    expect(enChat.agent_run_failed_notice).toBeTruthy();
  });
});

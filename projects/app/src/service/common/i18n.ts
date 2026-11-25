import { createApiI18n, type ApiI18n } from '@fastgpt/service/common/i18n/request';
import { generatedLoaders } from '@fastgpt/web/i18n/resourceLoaders.generated';

/**
 * 应用级 API i18n 单例。
 *
 * `createApiI18n` 在创建时即向 service 注册默认语言（en）翻译来源，因此后台任务、
 * 渠道回调等没有请求上下文的路径也能把 `ns:key` 解析成可读文案；同一实例被
 * `NextAPI` 入口复用，请求路径再把本轮语言绑定到 AsyncLocalStorage / res 上，
 * 两条路径共享同一份资源缓存，不会重复加载 i18n JSON。
 *
 * 这里保持模块级单例：多次创建会各自缓存一份 translator Promise，没有必要。
 */
export const apiI18n: ApiI18n = createApiI18n(generatedLoaders);

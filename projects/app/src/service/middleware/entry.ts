import { checkCsrf } from '@fastgpt/next/middle/csrf';
import { parseAllowedOrigins, withNextCors } from '@fastgpt/next/middle/cors';
import type { NextApiRequest, NextApiResponse } from '@fastgpt/next/type';
import { createApiEntry, type ApiHandler } from '@fastgpt/service/common/http/entry';
import { serviceEnv } from '@fastgpt/service/env';
import { apiI18n } from '@/service/common/i18n';

type NextAPIOptions = {
  csrf?: boolean;
  redactQueryParams?: string[];
};

/**
 * Next.js API 统一入口：CORS/CSRF 由适配层处理，日志、错误和采集上下文交给共享 HTTP 管线。
 * 仅请求携带 x-fastgpt-profile: 1 时启用分段性能采集，业务无需注册采集器。
 */
export const NextAPI = (
  ...args: (ApiHandler<any, NextApiRequest, NextApiResponse> | NextAPIOptions)[]
) => {
  const lastArg = args[args.length - 1];
  const options = typeof lastArg === 'object' ? lastArg : {};
  const handlers = (typeof lastArg === 'object' ? args.slice(0, -1) : args) as ApiHandler<
    any,
    NextApiRequest,
    NextApiResponse
  >[];
  const allowedOrigins = parseAllowedOrigins(serviceEnv.ALLOWED_ORIGINS);

  /** 按接口声明顺序执行 CORS 和 CSRF；CSRF 校验自身负责判断请求是否适用。 */
  const beforeRequest = async (req: NextApiRequest, res: NextApiResponse) => {
    await withNextCors({ req, res, allowedOrigins });

    if (options.csrf !== false && serviceEnv.CSRF_ENABLED) {
      await checkCsrf({ req, res });
    }
  };

  /**
   * 在本轮请求的 i18n 上下文中执行业务 handler：
   * 先把请求语言可用的 translator 绑定到 AsyncLocalStorage 与 res（异步回调也能读到），
   * 业务里的 `translateApiMessage` 才能按本轮语言解析 i18n key，而不是原样返回 key。
   * 资源加载失败只降级本次翻译，不影响业务处理。
   */
  const i18nHandlers = handlers.map(
    (handler) => (req: NextApiRequest, res: NextApiResponse) =>
      apiI18n({ req, res }, () => handler(req, res))
  );

  return createApiEntry<NextApiRequest, NextApiResponse>({
    beforeCallback: [beforeRequest],
    redactQueryParams: options.redactQueryParams
  })(...i18nHandlers);
};

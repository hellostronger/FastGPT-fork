/**
 * sandbox failed 事件的文案映射与最终错误卡片解析（纯函数，便于单测）。
 *
 * 服务端 failed 事件会带 step：`upgrade` 表示配置收敛/升级阶段失败，
 * `prepare` 表示运行环境准备失败。历史事件没有 step，必须回退到原通用文案，
 * 避免旧后端返回时前端显示空文案。
 */
import type { TFunction } from 'i18next';
import { I18N_NAMESPACES_MAP } from '@fastgpt/web/i18n/constants';

export type SandboxFailedStep = 'upgrade' | 'prepare';

export type SandboxFailedLabelKey =
  | 'sandbox_status_failed_prepare'
  | 'sandbox_status_failed_prepare_with_message'
  | 'sandbox_status_failed_upgrade'
  | 'sandbox_status_failed_upgrade_with_message'
  | 'sandbox_status_failed_with_message'
  | 'sandbox_status_failed';

export type SandboxFailedLabel = {
  key: SandboxFailedLabelKey;
  values?: { message: string };
};

/** failed 事件留在消息上的失败上下文；节点级错误优先于它。 */
export type SandboxErrorContext = {
  step?: string;
  message?: string;
  /** 触发沙箱准备的工作流节点；用于判断最终失败是否仍是该节点。 */
  nodeId?: string;
};

export type ChatItemErrorContent = {
  title: string;
  message: string;
  /** 次要信息：覆盖过 moduleName 的最终失败节点名。 */
  secondary?: string;
};

/** 按失败环节与是否带 message 选择 i18n key；无 step 时保持旧行为。 */
export const getSandboxFailedLabel = (
  step: string | undefined,
  message: string | undefined
): SandboxFailedLabel => {
  const values = typeof message === 'string' && message.length > 0 ? { message } : undefined;

  if (step === 'upgrade') {
    return values
      ? { key: 'sandbox_status_failed_upgrade_with_message', values }
      : { key: 'sandbox_status_failed_upgrade' };
  }
  if (step === 'prepare') {
    return values
      ? { key: 'sandbox_status_failed_prepare_with_message', values }
      : { key: 'sandbox_status_failed_prepare' };
  }

  return values
    ? { key: 'sandbox_status_failed_with_message', values }
    : { key: 'sandbox_status_failed' };
};

/**
 * 把 label 翻译成文案。
 *
 * 每个 key 都用字面量调用 `t`，禁止拼接 `chat:sandbox_status_${...}` 之类的动态 key，
 * 否则静态资源检查无法发现缺失的翻译。
 */
export const translateSandboxFailedLabel = (label: SandboxFailedLabel, t: TFunction): string => {
  switch (label.key) {
    case 'sandbox_status_failed_prepare':
      return t('chat:sandbox_status_failed_prepare');
    case 'sandbox_status_failed_prepare_with_message':
      return t('chat:sandbox_status_failed_prepare_with_message', label.values!);
    case 'sandbox_status_failed_upgrade':
      return t('chat:sandbox_status_failed_upgrade');
    case 'sandbox_status_failed_upgrade_with_message':
      return t('chat:sandbox_status_failed_upgrade_with_message', label.values!);
    case 'sandbox_status_failed_with_message':
      return t('chat:sandbox_status_failed_with_message', label.values!);
    case 'sandbox_status_failed':
      return t('chat:sandbox_status_failed');
  }
};

/**
 * 把服务端透传的失败原因翻译成当前语言。
 *
 * 服务端 `getErrText` 命中 `ERROR_RESPONSE` 时返回的是 i18n key
 * （如 `common:code_error.sandbox_error.agent_sandbox_limit_reached`），
 * 而 provider 的 `displayMessage` 已经是可读的纯文案。只对「已知 namespace 的 ns:key」
 * 调用 `t`，其余原样返回，避免把上游/用户文案当成 key 误翻译；
 * 翻译缺失（`t` 原样返回 key）时同样回退为原始 key，不显示空文案。
 */
export const translateSandboxFailureMessage = (message: string, t: TFunction): string => {
  const separator = message.indexOf(':');
  if (separator <= 0) return message;
  const namespace = message.slice(0, separator);
  const key = message.slice(separator + 1);
  if (!key || !I18N_NAMESPACES_MAP[namespace]) return message;

  const translated = t(message);
  return translated === message ? message : translated;
};

/**
 * 处理 sandbox 状态事件时写入 item 的失败上下文。
 *
 * 只有 failed 是终态；后续 successful 状态必须清空旧上下文，避免重试成功后仍展示旧原因。
 */
export const getSandboxErrorPatch = (status: {
  phase: string;
  step?: string;
  message?: string;
  nodeId?: string;
}): { sandboxError?: SandboxErrorContext } => {
  if (status.phase !== 'failed') return { sandboxError: undefined };

  const step = status.step === 'upgrade' || status.step === 'prepare' ? status.step : undefined;
  const message = status.message && status.message.length > 0 ? status.message : undefined;
  const nodeId = status.nodeId && status.nodeId.length > 0 ? status.nodeId : undefined;
  return { sandboxError: { step, message, ...(nodeId ? { nodeId } : {}) } };
};

/**
 * 解析聊天气泡底部错误卡片内容。
 *
 * 失败原因归属到实际失败的节点，而不是整条消息：
 * 1. 最终失败节点不是沙箱节点时（例如沙箱错误被 catch 后，后续 HTTP 节点返回 503），
 *    展示该节点的真实错误，沙箱环节与原因降为次要信息，绝不覆盖真实原因；
 * 2. 最终失败节点就是沙箱节点（或没有任何节点级错误，只能使用消息级兜底）时，
 *    标题展示失败环节，正文优先展示 provider 可展示原因；
 * 3. 没有 sandbox 上下文时保持原有“运行错误 - 节点名 / 节点错误文案”的行为。
 */
export const resolveChatItemErrorContent = ({
  errorMsg,
  errorText,
  moduleName,
  sandboxError,
  failedNodeId,
  logErrorPrefix,
  t
}: {
  errorMsg?: string;
  errorText?: { moduleName?: string; errorText?: string };
  moduleName?: string;
  sandboxError?: SandboxErrorContext;
  /** 最终失败节点的 workflow nodeId（来自 responseData）；缺失表示没有节点级信息。 */
  failedNodeId?: string;
  logErrorPrefix: string;
  t: TFunction;
}): ChatItemErrorContent | undefined => {
  if (!errorMsg && !errorText) return undefined;

  const nodeName = errorText?.moduleName || moduleName;
  const nodeNameText = nodeName ? t(nodeName) : undefined;
  const nodeErrorText = t(errorText?.errorText || errorMsg || 'Unknow error');

  if (sandboxError) {
    const phaseLabel = translateSandboxFailedLabel(
      getSandboxFailedLabel(sandboxError.step, undefined),
      t
    );
    // 服务端可能透传 i18n key（ERROR_RESPONSE 映射）或 provider 可读文案，统一在这里归一。
    const sandboxMessage = sandboxError.message
      ? translateSandboxFailureMessage(sandboxError.message, t)
      : undefined;
    // 只有失败节点就是沙箱节点，或完全没有节点级错误时才使用沙箱文案。
    const sandboxNodeFailed =
      !errorText || (!!sandboxError.nodeId && failedNodeId === sandboxError.nodeId);

    if (sandboxNodeFailed) {
      const message =
        sandboxMessage ||
        (errorText?.errorText ? t(errorText.errorText) : undefined) ||
        (errorMsg ? t(errorMsg) : undefined) ||
        t('Unknow error');

      return {
        title: `${logErrorPrefix} - ${phaseLabel}`,
        message,
        secondary: nodeNameText
      };
    }

    // 后续节点真实失败：保留节点错误，把更早的沙箱失败降为次要信息。
    return {
      title: nodeNameText ? `${logErrorPrefix} - ${nodeNameText}` : logErrorPrefix,
      message: nodeErrorText,
      secondary: sandboxMessage ? `${phaseLabel}：${sandboxMessage}` : phaseLabel
    };
  }

  return {
    title: nodeNameText ? `${logErrorPrefix} - ${nodeNameText}` : logErrorPrefix,
    message: nodeErrorText
  };
};

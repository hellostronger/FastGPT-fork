import { describe, expect, it } from 'vitest';
import {
  CommandExecutionError,
  ConnectionError,
  SANDBOX_TERMINAL_CODES,
  SEALOS_DEVBOX_CREATE_REJECTED_CODE,
  SEALOS_DEVBOX_FAILED_CODE,
  SandboxException,
  SandboxNotFoundError,
  SandboxStateError,
  SandboxTerminationError,
  getSandboxFailureDetail,
  isRecoverableSandboxUnavailable
} from '@/errors';

describe('sandbox errors', () => {
  it('serializes the shared error fields and cause', () => {
    const cause = new Error('root cause');
    const error = new SandboxException('failed', 'UNEXPECTED_RESPONSE', cause);

    expect(error.toJSON()).toMatchObject({
      name: 'SandboxException',
      message: 'failed',
      code: 'UNEXPECTED_RESPONSE',
      cause
    });
  });

  it('preserves process results and exposes a combined diagnostic', () => {
    const error = new CommandExecutionError('failed', 'exit 1', 1, 'stdout', 'stderr');

    expect(error).toMatchObject({
      code: 'COMMAND_FAILED',
      command: 'exit 1',
      exitCode: 1,
      stdout: 'stdout',
      stderr: 'stderr'
    });
    expect(error.getCombinedOutput()).toBe('stdout\nstderr');
    expect(new CommandExecutionError('failed', 'exit 1', 1, '', 'stderr').getCombinedOutput()).toBe(
      'stderr'
    );
  });

  it('preserves command causes without inventing process output', () => {
    const cause = new Error('transport failed');
    const error = new CommandExecutionError('failed', 'echo test', cause);

    expect(error.commandError).toBe(cause);
    expect(error.cause).toBe(cause);
    expect(error.getCombinedOutput()).toBe('');
  });
});

describe('getSandboxFailureDetail', () => {
  it('reads provider termination through the real SDK wrapper chain', () => {
    // 真实包装形态：ConnectionError 包 SandboxTerminationError，cause 里是 provider 证据。
    const termination = new SandboxTerminationError(
      'KUBERNETES::POD_FAILED',
      'primary reason=ContainerFailed; container sandbox exited with code 127 (pod sample-pod-7f9c)',
      {
        message:
          'KUBERNETES::POD_FAILED: primary reason=ContainerFailed; container sandbox exited with code 127 (pod sample-pod-7f9c)'
      }
    );
    const wrapped = new ConnectionError(
      'Failed to create sandbox',
      'http://opensandbox.local',
      termination
    );

    const detail = getSandboxFailureDetail(wrapped);

    expect(detail).toMatchObject({ code: 'KUBERNETES::POD_FAILED', terminated: true });
    expect(detail?.displayMessage).toContain('ContainerFailed');
    expect(detail?.displayMessage).toContain('sample-pod-7f9c');
    expect(detail?.displayMessage).not.toContain('\n');
    expect(detail?.displayMessage).not.toBe('Failed to create sandbox');
  });

  it('reads structured code/message from a provider payload and flattens whitespace', () => {
    const detail = getSandboxFailureDetail({
      code: 'KUBERNETES::POD_FAILED',
      message: 'pod sample-pod-7f9c crashed:\n  primary reason=ContainerFailed'
    });

    expect(detail).toMatchObject({ code: 'KUBERNETES::POD_FAILED', terminated: true });
    expect(detail?.displayMessage).toContain('ContainerFailed');
    expect(detail?.displayMessage).not.toContain('\n');
  });

  it('keeps timeout codes as unknown even when wrapped', () => {
    const wrapped = new ConnectionError('Failed to create sandbox', 'http://opensandbox.local', {
      code: 'KUBERNETES::POD_READY_TIMEOUT',
      message: 'sandbox did not become ready'
    });

    const detail = getSandboxFailureDetail(wrapped);

    expect(detail?.terminated).toBe(false);
    expect(detail?.code).toBe('KUBERNETES::POD_READY_TIMEOUT');
    expect(detail?.displayMessage).toContain('did not become ready');
  });

  it('returns undefined when there is no structured evidence', () => {
    // 文本里出现终止特征也不能当成结构化证据。
    expect(
      getSandboxFailureDetail(new Error('container sandbox exited with code 1'))
    ).toBeUndefined();
    expect(getSandboxFailureDetail(undefined)).toBeUndefined();
    expect(getSandboxFailureDetail('KUBERNETES::POD_FAILED')).toBeUndefined();
  });

  it('ignores bare transport/system codes instead of treating them as provider evidence', () => {
    // axios/Node 的网络错误把系统码放在 code 上，这不是 provider 结构化证据；
    // 若被当成失败契约，displayMessage 会把内部地址透出到最终错误卡片。
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET']) {
      expect(
        getSandboxFailureDetail({
          code,
          message: `connect ${code} 10.0.0.12:6443`
        })
      ).toBeUndefined();
    }

    // 外层包装文案同样不能把裸网络码升级成 provider 码。
    const wrapped = new ConnectionError('Failed to create sandbox', 'http://10.0.0.12:6443', {
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 10.0.0.12:6443'
    });
    expect(getSandboxFailureDetail(wrapped)).toBeUndefined();
  });

  it('still reports namespaced provider codes that are not terminal', () => {
    // 收敛后只按命名空间过滤，provider 未知/超时码仍要透传结构化证据。
    expect(
      getSandboxFailureDetail({ code: 'KUBERNETES::POD_READY_TIMEOUT', message: 'not ready' })
    ).toMatchObject({ code: 'KUBERNETES::POD_READY_TIMEOUT', terminated: false });
    expect(
      getSandboxFailureDetail({ code: 'SEALOS_DEVBOX::UNKNOWN_PHASE', message: 'unknown' })
    ).toMatchObject({ code: 'SEALOS_DEVBOX::UNKNOWN_PHASE', terminated: false });
  });

  it('exposes the single terminal code table for both providers', () => {
    expect(SANDBOX_TERMINAL_CODES).toContain('KUBERNETES::POD_FAILED');
    expect(SANDBOX_TERMINAL_CODES).not.toContain('KUBERNETES::POD_READY_TIMEOUT');
    // devbox 码与 opensandbox 码在同一张表：provider 边界只产出证据，码表只有一份。
    expect(SANDBOX_TERMINAL_CODES).toContain('SEALOS_DEVBOX::FAILED');
    expect(SANDBOX_TERMINAL_CODES).toContain('SEALOS_DEVBOX::CREATE_REJECTED');
    // adapter 复用的常量就是码表本体，不再是第二个字面量来源。
    expect(SANDBOX_TERMINAL_CODES).toContain(SEALOS_DEVBOX_FAILED_CODE);
    expect(SANDBOX_TERMINAL_CODES).toContain(SEALOS_DEVBOX_CREATE_REJECTED_CODE);
    // 早期从文本特征合成的兼容码从未发布，不再参与终止判定。
    expect(SANDBOX_TERMINAL_CODES).not.toContain('CONTAINER_FAILED');
    expect(SANDBOX_TERMINAL_CODES).not.toContain('INIT_CONTAINER_FAILED');
    expect(SANDBOX_TERMINAL_CODES).not.toContain('CONTAINER_EXITED');
  });

  it('stops walking a self-referencing cause chain instead of looping', () => {
    const error: { code: string; message: string; cause?: unknown } = {
      code: 'KUBERNETES::POD_FAILED',
      message: 'pod sample-pod-7f9c failed'
    };
    error.cause = error;

    expect(getSandboxFailureDetail(error)).toMatchObject({
      code: 'KUBERNETES::POD_FAILED',
      terminated: true
    });
  });

  it('reads devbox termination evidence from a provider-shaped record', () => {
    const detail = getSandboxFailureDetail({
      code: 'SEALOS_DEVBOX::FAILED',
      message: 'pod sandbox-1 failed:\nOOMKilled'
    });

    expect(detail).toMatchObject({ code: 'SEALOS_DEVBOX::FAILED', terminated: true });
    expect(detail?.displayMessage).toContain('OOMKilled');
    expect(detail?.displayMessage).not.toContain('\n');
  });
});

describe('isRecoverableSandboxUnavailable', () => {
  it('accepts the three unavailable outcomes that lifecycle may rebuild', () => {
    expect(isRecoverableSandboxUnavailable(new SandboxNotFoundError('missing'))).toBe(true);
    expect(isRecoverableSandboxUnavailable(new SandboxStateError('stopped', 'Stopped'))).toBe(true);
    expect(
      isRecoverableSandboxUnavailable(
        new SandboxTerminationError('SEALOS_DEVBOX::FAILED', 'container OOMKilled')
      )
    ).toBe(true);
  });

  it('rejects unknown transport failures so callers keep the isolation window', () => {
    expect(
      isRecoverableSandboxUnavailable(
        new ConnectionError('gateway timeout', 'http://provider', new Error('ETIMEDOUT'))
      )
    ).toBe(false);
    expect(isRecoverableSandboxUnavailable(new SandboxException('unexpected response'))).toBe(
      false
    );
    expect(isRecoverableSandboxUnavailable(new Error('boom'))).toBe(false);
    expect(isRecoverableSandboxUnavailable(undefined)).toBe(false);
  });
});

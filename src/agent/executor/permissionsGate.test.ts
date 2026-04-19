import { describe, it, expect } from 'vitest';
import { resolveApprovalNeeded, WRITE_TOOLS, NATIVE_MODAL_APPROVAL_TOOLS } from './permissionsGate.js';

const tool = (requiresApproval = false, alwaysRequireApproval = false) => ({
  requiresApproval,
  alwaysRequireApproval,
});

describe('resolveApprovalNeeded', () => {
  it('alwaysRequireApproval overrides autonomous mode + allow permission', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(false, true),
        approvalMode: 'autonomous',
        explicitPermission: 'allow',
        isIrrecoverable: false,
      }),
    ).toBe(true);
  });

  it('isIrrecoverable forces approval even in autonomous mode with allow', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(false, false),
        approvalMode: 'autonomous',
        explicitPermission: 'allow',
        isIrrecoverable: true,
      }),
    ).toBe(true);
  });

  it('explicit allow skips approval when no override flags set', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(true, false),
        approvalMode: 'cautious',
        explicitPermission: 'allow',
        isIrrecoverable: false,
      }),
    ).toBe(false);
  });

  it('explicit ask forces approval regardless of mode', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(false, false),
        approvalMode: 'autonomous',
        explicitPermission: 'ask',
        isIrrecoverable: false,
      }),
    ).toBe(true);
  });

  it('manual mode always requires approval for any tool', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(false, false),
        approvalMode: 'manual',
        explicitPermission: undefined,
        isIrrecoverable: false,
      }),
    ).toBe(true);
  });

  it('cautious mode requires approval when tool.requiresApproval is true', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(true, false),
        approvalMode: 'cautious',
        explicitPermission: undefined,
        isIrrecoverable: false,
      }),
    ).toBe(true);
  });

  it('cautious mode skips approval when tool.requiresApproval is false', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(false, false),
        approvalMode: 'cautious',
        explicitPermission: undefined,
        isIrrecoverable: false,
      }),
    ).toBe(false);
  });

  it('autonomous mode with no overrides never requires approval', () => {
    expect(
      resolveApprovalNeeded({
        tool: tool(true, false),
        approvalMode: 'autonomous',
        explicitPermission: undefined,
        isIrrecoverable: false,
      }),
    ).toBe(false);
  });
});

describe('WRITE_TOOLS', () => {
  it('contains write_file and edit_file', () => {
    expect(WRITE_TOOLS.has('write_file')).toBe(true);
    expect(WRITE_TOOLS.has('edit_file')).toBe(true);
  });
  it('does not contain read_file', () => {
    expect(WRITE_TOOLS.has('read_file')).toBe(false);
  });
});

describe('NATIVE_MODAL_APPROVAL_TOOLS', () => {
  it('contains run_command and git_push', () => {
    expect(NATIVE_MODAL_APPROVAL_TOOLS.has('run_command')).toBe(true);
    expect(NATIVE_MODAL_APPROVAL_TOOLS.has('git_push')).toBe(true);
  });
  it('does not contain write_file (write tools use diff-preview path)', () => {
    expect(NATIVE_MODAL_APPROVAL_TOOLS.has('write_file')).toBe(false);
  });
});

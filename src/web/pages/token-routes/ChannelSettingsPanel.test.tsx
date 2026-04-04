import { describe, expect, it, vi } from 'vitest';
import { create, act } from 'react-test-renderer';
import { ChannelSettingsPanel } from './ChannelSettingsPanel.js';
import type { RouteChannel, RouteTokenOption } from './types.js';
import ModernSelect from '../../components/ModernSelect.js';

function buildChannel(overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id: 1,
    accountId: 10,
    tokenId: null,
    priority: 0,
    weight: 10,
    enabled: true,
    manualOverride: false,
    successCount: 5,
    failCount: 0,
    account: { username: 'test-user', credentialMode: 'session' },
    site: { id: 100, name: 'test-site', platform: 'openai' },
    token: null,
    ...overrides,
  };
}

const defaultTokenOptions: RouteTokenOption[] = [
  { id: 1, name: 'token-a', isDefault: true },
  { id: 2, name: 'token-b', isDefault: false },
];

describe('ChannelSettingsPanel', () => {
  it('submits only dirty fields in onSave payload (priority only)', () => {
    const onSave = vi.fn();
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({ priority: 0, weight: 10 })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={onSave}
      />,
    );

    // Change only priority
    const priorityInput = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    )[0];
    act(() => {
      priorityInput.props.onChange({ target: { value: '2' } });
    });

    // Click save
    const saveButton = root.root.findAll(
      (node) => node.type === 'button' && node.children?.some?.((c) => typeof c === 'string' && c === '保存'),
    )[0];
    act(() => {
      saveButton.props.onClick();
    });

    // Should only contain priority (not tokenId or weight)
    expect(onSave).toHaveBeenCalledWith(1, { priority: 2 });
  });

  it('disables save button when no fields are dirty', () => {
    const onSave = vi.fn();
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel()}
        tokenOptions={defaultTokenOptions}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={onSave}
      />,
    );

    const saveButton = root.root.findAll(
      (node) => node.type === 'button' && node.children?.some?.((c) => typeof c === 'string' && c === '保存'),
    )[0];

    expect(saveButton).toBeDefined();
    expect(saveButton.props.disabled).toBe(true);
  });

  it('auto-clears dirty when user changes value back to baseline', () => {
    const onSave = vi.fn();
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({ priority: 5 })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={onSave}
      />,
    );

    const priorityInput = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    )[0];

    // Change priority away from baseline
    act(() => {
      priorityInput.props.onChange({ target: { value: '3' } });
    });

    // Save button should be enabled
    let saveButton = root.root.findAll(
      (node) => node.type === 'button' && node.children?.some?.((c) => typeof c === 'string' && c === '保存'),
    )[0];
    expect(saveButton.props.disabled).toBe(false);

    // Change back to baseline value
    act(() => {
      priorityInput.props.onChange({ target: { value: '5' } });
    });

    // Save button should be disabled again
    saveButton = root.root.findAll(
      (node) => node.type === 'button' && node.children?.some?.((c) => typeof c === 'string' && c === '保存'),
    )[0];
    expect(saveButton.props.disabled).toBe(true);
  });

  it('renders priority and weight inputs with correct initial values', () => {
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({ priority: 2, weight: 50 })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={vi.fn()}
      />,
    );

    const numberInputs = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    );

    expect(numberInputs.length).toBe(2);
    expect(numberInputs[0].props.value).toBe(2); // priority
    expect(numberInputs[1].props.value).toBe(50); // weight
  });

  it('clamps priority to non-negative integer on change', () => {
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({ priority: 0 })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={vi.fn()}
      />,
    );

    const priorityInput = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    )[0];

    // Simulate entering a negative value
    act(() => {
      priorityInput.props.onChange({ target: { value: '-5' } });
    });

    const updatedInput = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    )[0];
    expect(updatedInput.props.value).toBe(0);
  });

  it('clamps weight to 0-1000 range on change', () => {
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({ weight: 10 })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={vi.fn()}
      />,
    );

    const weightInput = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    )[1];

    // Simulate entering a value above max
    act(() => {
      weightInput.props.onChange({ target: { value: '1500' } });
    });

    const updatedInput = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    )[1];
    expect(updatedInput.props.value).toBe(1000);
  });

  it('syncs draft when channel prop changes externally', () => {
    const channel = buildChannel({ priority: 0, weight: 10 });
    const root = create(
      <ChannelSettingsPanel
        channel={channel}
        tokenOptions={defaultTokenOptions}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={vi.fn()}
      />,
    );

    const updatedChannel = buildChannel({ priority: 3, weight: 20 });
    act(() => {
      root.update(
        <ChannelSettingsPanel
          channel={updatedChannel}
          tokenOptions={defaultTokenOptions}
          activeTokenId={0}
          isUpdatingToken={false}
          onSave={vi.fn()}
        />,
      );
    });

    const numberInputs = root.root.findAll(
      (node) => node.type === 'input' && node.props.type === 'number',
    );
    expect(numberInputs[0].props.value).toBe(3);
    expect(numberInputs[1].props.value).toBe(20);
  });

  it('shows account-principal copy for apikey direct-routing channels', () => {
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({
          account: {
            username: 'welfare-user',
            credentialMode: 'apikey',
            accessToken: '',
          },
        })}
        tokenOptions={[]}
        activeTokenId={0}
        isUpdatingToken={false}
        onSave={vi.fn()}
      />,
    );

    const select = root.root.findByType(ModernSelect);
    const optionLabels = (select.props.options as Array<{ label: string }>).map((option) => option.label);

    expect(optionLabels[0]).toBe('账号主凭证');
    expect(optionLabels).not.toContain('跟随账号默认');
  });

  it('does not offer account-principal binding for managed-token session channels', () => {
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({
          tokenId: 1,
          token: { id: 1, name: 'token-a', accountId: 10, enabled: true, isDefault: true },
          account: {
            username: 'session-user',
            credentialMode: 'session',
            accessToken: 'session-token',
          },
        })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={1}
        isUpdatingToken={false}
        onSave={vi.fn()}
      />,
    );

    const select = root.root.findByType(ModernSelect);
    const optionLabels = (select.props.options as Array<{ label: string }>).map((option) => option.label);

    expect(optionLabels).not.toContain('账号主凭证');
    expect(optionLabels).toContain('跟随账号默认');
    expect(optionLabels).toContain('固定使用：token-a（当前账号默认）');
    expect(optionLabels).toContain('固定使用：token-b');
  });

  it('submits tokenId=0 when switching a managed-token channel back to follow-default', () => {
    const onSave = vi.fn();
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({
          tokenId: 2,
          token: { id: 2, name: 'token-b', accountId: 10, enabled: true, isDefault: false },
          account: {
            username: 'session-user',
            credentialMode: 'session',
            accessToken: 'session-token',
          },
        })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={2}
        isUpdatingToken={false}
        onSave={onSave}
      />,
    );

    const select = root.root.findByType(ModernSelect);
    act(() => {
      select.props.onChange('0');
    });

    const saveButton = root.root.findAll(
      (node) => node.type === 'button' && node.children?.some?.((child) => typeof child === 'string' && child === '保存'),
    )[0];
    act(() => {
      saveButton.props.onClick();
    });

    expect(onSave).toHaveBeenCalledWith(1, { tokenId: 0 });
  });

  it('submits tokenId=null when switching a direct-account channel to account-primary binding', () => {
    const onSave = vi.fn();
    const root = create(
      <ChannelSettingsPanel
        channel={buildChannel({
          tokenId: 1,
          token: { id: 1, name: 'token-a', accountId: 10, enabled: true, isDefault: true },
          account: {
            username: 'welfare-user',
            credentialMode: 'apikey',
            accessToken: '',
          },
        })}
        tokenOptions={defaultTokenOptions}
        activeTokenId={1}
        isUpdatingToken={false}
        onSave={onSave}
      />,
    );

    const select = root.root.findByType(ModernSelect);
    act(() => {
      select.props.onChange('0');
    });

    const saveButton = root.root.findAll(
      (node) => node.type === 'button' && node.children?.some?.((child) => typeof child === 'string' && child === '保存'),
    )[0];
    act(() => {
      saveButton.props.onClick();
    });

    expect(onSave).toHaveBeenCalledWith(1, { tokenId: null });
  });
});

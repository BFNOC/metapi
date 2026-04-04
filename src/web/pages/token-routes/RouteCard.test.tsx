import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import RouteCard from './RouteCard.js';
import type { RouteSummaryRow } from './types.js';

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

const LONG_REGEX_PATTERN = 're:(?:.*|.*/)(minimax-m2.1)$';

function buildRoute(overrides: Partial<RouteSummaryRow> = {}): RouteSummaryRow {
  return {
    id: 42,
    modelPattern: LONG_REGEX_PATTERN,
    displayName: 'm.',
    displayIcon: null,
    modelMapping: null,
    routingStrategy: 'weighted',
    enabled: true,
    channelCount: 4,
    enabledChannelCount: 4,
    siteNames: ['site-a'],
    decisionSnapshot: null,
    decisionRefreshedAt: null,
    ...overrides,
  };
}

describe('RouteCard', () => {
  it('truncates the collapsed regex badge while keeping the group name primary', () => {
    const root = create(
      <RouteCard
        route={buildRoute()}
        brand={null}
        expanded={false}
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onClearCooldown={vi.fn()}
        clearingCooldown={false}
        onRoutingStrategyChange={vi.fn()}
        updatingRoutingStrategy={false}
        channels={undefined}
        loadingChannels={false}
        routeDecision={null}
        loadingDecision={false}
        candidateView={{ routeCandidates: [], accountOptions: [], tokenOptionsByAccountId: {} }}

        updatingChannel={{}}
        savingPriority={false}
        onSaveSettings={vi.fn()}
        onDeleteChannel={vi.fn()}
        onToggleChannelEnabled={vi.fn()}
        onChannelDragEnd={vi.fn()}
        missingTokenSiteItems={[]}
        missingTokenGroupItems={[]}
        onCreateTokenForMissing={vi.fn()}
        onAddChannel={vi.fn()}
        onResetPriority={vi.fn()}
        resettingPriority={false}
        onSiteBlockModel={vi.fn()}
        expandedSourceGroupMap={{}}
        onToggleSourceGroup={vi.fn()}
      />,
    );

    expect(collectText(root.root)).toContain('m.');

    const regexBadge = root.root.find((node) => (
      node.type === 'span'
      && typeof node.props.className === 'string'
      && node.props.className.includes('badge-muted')
      && collectText(node) === LONG_REGEX_PATTERN
    ));

    expect(regexBadge.props.style).toMatchObject({
      maxWidth: 180,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flexShrink: 1,
    });
  });

  it('renders a clear cooldown action on expanded cards', () => {
    const onClearCooldown = vi.fn();
    const root = create(
      <RouteCard
        route={buildRoute()}
        brand={null}
        expanded
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onClearCooldown={onClearCooldown}
        clearingCooldown={false}
        onRoutingStrategyChange={vi.fn()}
        updatingRoutingStrategy={false}
        channels={[]}
        loadingChannels={false}
        routeDecision={null}
        loadingDecision={false}
        candidateView={{ routeCandidates: [], accountOptions: [], tokenOptionsByAccountId: {} }}
        updatingChannel={{}}
        savingPriority={false}
        onSaveSettings={vi.fn()}
        onDeleteChannel={vi.fn()}
        onToggleChannelEnabled={vi.fn()}
        onChannelDragEnd={vi.fn()}
        missingTokenSiteItems={[]}
        missingTokenGroupItems={[]}
        onCreateTokenForMissing={vi.fn()}
        onAddChannel={vi.fn()}
        onResetPriority={vi.fn()}
        resettingPriority={false}
        onSiteBlockModel={vi.fn()}
        expandedSourceGroupMap={{}}
        onToggleSourceGroup={vi.fn()}
      />,
    );

    const button = root.root.find((node) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).trim() === '清除冷却'
    ));

    button.props.onClick();
    expect(onClearCooldown).toHaveBeenCalledTimes(1);
    expect(onClearCooldown).toHaveBeenCalledWith(42);
  });

  it('opens the ranking confirmation modal before applying probe ranking', () => {
    const onApplyProbeRanking = vi.fn();
    const root = create(
      <RouteCard
        route={buildRoute()}
        brand={null}
        expanded
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onClearCooldown={vi.fn()}
        clearingCooldown={false}
        onRoutingStrategyChange={vi.fn()}
        updatingRoutingStrategy={false}
        channels={[]}
        loadingChannels={false}
        routeDecision={null}
        loadingDecision={false}
        candidateView={{ routeCandidates: [], accountOptions: [], tokenOptionsByAccountId: {} }}
        updatingChannel={{}}
        savingPriority={false}
        onSaveSettings={vi.fn()}
        onDeleteChannel={vi.fn()}
        onToggleChannelEnabled={vi.fn()}
        onChannelDragEnd={vi.fn()}
        missingTokenSiteItems={[]}
        missingTokenGroupItems={[]}
        onCreateTokenForMissing={vi.fn()}
        onAddChannel={vi.fn()}
        onResetPriority={vi.fn()}
        resettingPriority={false}
        onSiteBlockModel={vi.fn()}
        expandedSourceGroupMap={{}}
        onToggleSourceGroup={vi.fn()}
        routeProbeSession={{
          controller: new AbortController(),
          expectedCount: 2,
          completedCount: 2,
          done: true,
          results: {
            11: {
              channelId: 11,
              status: 'supported',
              ttftMs: 120,
              httpStatus: 200,
              error: null,
            },
            12: {
              channelId: 12,
              status: 'unsupported',
              ttftMs: null,
              httpStatus: 401,
              error: null,
            },
          },
        }}
        onApplyProbeRanking={onApplyProbeRanking}
      />,
    );

    const applyRankingButtons = root.root.findAll((node) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).trim() === '应用探活排序'
    ));

    expect(applyRankingButtons).toHaveLength(1);

    act(() => {
      applyRankingButtons[0].props.onClick();
    });

    expect(onApplyProbeRanking).not.toHaveBeenCalled();
  });

  it('shows skipped probe results separately from unknown results in the summary', () => {
    const root = create(
      <RouteCard
        route={buildRoute()}
        brand={null}
        expanded
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onClearCooldown={vi.fn()}
        clearingCooldown={false}
        onRoutingStrategyChange={vi.fn()}
        updatingRoutingStrategy={false}
        channels={[]}
        loadingChannels={false}
        routeDecision={null}
        loadingDecision={false}
        candidateView={{ routeCandidates: [], accountOptions: [], tokenOptionsByAccountId: {} }}
        updatingChannel={{}}
        savingPriority={false}
        onSaveSettings={vi.fn()}
        onDeleteChannel={vi.fn()}
        onToggleChannelEnabled={vi.fn()}
        onChannelDragEnd={vi.fn()}
        missingTokenSiteItems={[]}
        missingTokenGroupItems={[]}
        onCreateTokenForMissing={vi.fn()}
        onAddChannel={vi.fn()}
        onResetPriority={vi.fn()}
        resettingPriority={false}
        onSiteBlockModel={vi.fn()}
        expandedSourceGroupMap={{}}
        onToggleSourceGroup={vi.fn()}
        routeProbeSession={{
          controller: new AbortController(),
          expectedCount: 3,
          completedCount: 3,
          done: true,
          results: {
            11: {
              channelId: 11,
              status: 'supported',
              ttftMs: 120,
              httpStatus: 200,
              error: null,
            },
            12: {
              channelId: 12,
              status: 'skipped',
              ttftMs: null,
              httpStatus: null,
              error: '通道无有效探活令牌',
            },
            13: {
              channelId: 13,
              status: 'inconclusive',
              ttftMs: null,
              httpStatus: 200,
              error: 'Probe returned no result',
            },
          },
        }}
      />,
    );

    const text = collectText(root.root);
    expect(text).toContain('✅ 1 成功');
    expect(text).toContain('⏭ 1 跳过');
    expect(text).toContain('❓ 1 未知');
  });
});

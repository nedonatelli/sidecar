import { window, commands, workspace, ExtensionContext, StatusBarAlignment, ThemeColor, MarkdownString } from 'vscode';
import { getConfig, isLocalOllama, isKickstand } from '../config/settings.js';
import { healthStatus, type HealthSnapshot } from '../ollama/healthStatus.js';
import { spendTracker, formatUsd } from '../ollama/spendTracker.js';
import { circuitBreaker } from '../ollama/circuitBreaker.js';
import type { ChatViewProvider } from '../webview/chatView.js';

export interface StatusBarDeps {
  getChatProvider: () => ChatViewProvider | undefined;
}

/**
 * Create and register the SideCar status bar (model health + spend tracker)
 * plus the showSpend and resetSpend commands.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function registerStatusBar(context: ExtensionContext, deps: StatusBarDeps): void {
  const { getChatProvider } = deps;

  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right, 100);
  statusBar.command = 'sidecar.toggleChat';

  function providerLabel(baseUrl: string): string {
    if (isLocalOllama(baseUrl)) return 'Ollama';
    if (baseUrl.includes('anthropic')) return 'Anthropic';
    if (baseUrl.includes('openai')) return 'OpenAI';
    if (isKickstand(baseUrl)) return 'Kickstand';
    return 'Remote';
  }

  function renderStatusBar(health: HealthSnapshot): void {
    const cfg = getConfig();
    const liveModel = getChatProvider()?.client.getModel() ?? cfg.model;
    const shortModel = liveModel.split(':')[0];
    const provider = providerLabel(cfg.baseUrl);

    let icon: string;
    let bgColor: ThemeColor | undefined;
    let statusLine: string;
    switch (health.status) {
      case 'error':
        icon = '$(error)';
        bgColor = new ThemeColor('statusBarItem.errorBackground');
        statusLine = `**Disconnected** — ${health.detail ?? 'backend error'}`;
        break;
      case 'degraded':
        icon = '$(warning)';
        bgColor = new ThemeColor('statusBarItem.warningBackground');
        statusLine = `**Degraded** — ${health.detail ?? 'rate-limited'}`;
        break;
      case 'ok':
        icon = '$(hubot)';
        bgColor = undefined;
        statusLine = '**Ready** — last request succeeded';
        break;
      default:
        icon = '$(hubot)';
        bgColor = undefined;
        statusLine = 'Ready — no requests yet this session';
    }

    statusBar.text = `${icon} ${shortModel}`;
    statusBar.backgroundColor = bgColor;

    const md = new MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = false;
    md.appendMarkdown(`### SideCar\n\n`);
    md.appendMarkdown(`${statusLine}\n\n`);
    md.appendMarkdown(`**Model:** \`${liveModel}\`  \n`);
    md.appendMarkdown(`**Backend:** ${provider}\n\n`);

    const router = getChatProvider()?.client.getRouter();
    if (router) {
      const rules = router.getRules();
      if (rules.length > 0) {
        md.appendMarkdown(`---\n\n**Routing:** ${rules.length} rule(s) active  \n`);
        for (const rule of rules) {
          const usd = router.getRuleSpendUsd(rule);
          const over = router.isRuleOverBudget(rule);
          const line = `\`${rule.when}\` → \`${rule.model}\`` + (usd > 0 ? ` · ${formatUsd(usd)}` : '');
          md.appendMarkdown(over ? `- ${line} *(budget hit)*  \n` : `- ${line}  \n`);
        }
        md.appendMarkdown(`\n`);
      }
    }

    const override = getChatProvider()?.client.getTurnOverride();
    if (override) {
      md.appendMarkdown(`---\n\n**Sentinel pin:** \`${override}\` (this turn only)\n\n`);
    }

    if (health.lastError && health.status === 'error') {
      md.appendMarkdown(`---\n\n**Last error:**\n\n\`\`\`\n${health.lastError}\n\`\`\`\n\n`);
    }
    md.appendMarkdown(`[Toggle chat](command:sidecar.toggleChat) · `);
    md.appendMarkdown(`[Switch backend](command:sidecar.switchBackend) · `);
    md.appendMarkdown(`[Set API key](command:sidecar.setApiKey)`);
    statusBar.tooltip = md;
  }

  renderStatusBar(healthStatus.get());
  statusBar.show();

  // Spend bar
  const spendBar = window.createStatusBarItem(StatusBarAlignment.Right, 99);
  spendBar.command = 'sidecar.showSpend';
  spendBar.text = `$(credit-card) ${formatUsd(0)}`;
  spendBar.tooltip = 'SideCar — estimated session spend (click for breakdown)';
  spendBar.hide();

  context.subscriptions.push(
    statusBar,
    healthStatus.onDidChange((snap) => renderStatusBar(snap)),
    spendTracker.onDidChange(() => renderStatusBar(healthStatus.get())),
    spendBar,
    spendTracker.onDidChange((snap) => {
      if (snap.byModel.length === 0) {
        spendBar.hide();
        return;
      }
      spendBar.text = `$(credit-card) ${formatUsd(snap.totalUsd)}`;
      spendBar.tooltip = `SideCar — ${formatUsd(snap.totalUsd)} estimated across ${snap.totalRequests} request(s). Click for breakdown.`;
      spendBar.show();
    }),
    commands.registerCommand('sidecar.showSpend', async () => {
      const snap = spendTracker.snapshot();
      const { getCriticStats, resetCriticStats } = await import('../agent/loop/criticHook.js');
      const critic = getCriticStats();
      if (snap.byModel.length === 0 && critic.totalCalls === 0) {
        window.showInformationMessage('SideCar: no remote API spend or critic activity tracked this session.');
        return;
      }
      const items = snap.byModel.map((m) => ({
        label: `${formatUsd(m.costUsd)}  ·  ${m.model}`,
        description: `${m.requests} request(s)`,
        detail: `in ${m.usage.inputTokens.toLocaleString()} · out ${m.usage.outputTokens.toLocaleString()} · cache write ${m.usage.cacheCreationInputTokens.toLocaleString()} · cache read ${m.usage.cacheReadInputTokens.toLocaleString()}`,
      }));
      const sessionMinutes = Math.max(1, Math.round((Date.now() - snap.sessionStart) / 60_000));
      items.unshift({
        label: `$(info) Total: ${formatUsd(snap.totalUsd)}`,
        description: `${snap.totalRequests} request(s) over ${sessionMinutes} min`,
        detail: 'Estimated — list prices; actual billing may differ. Click "Reset" below to clear.',
      });
      if (critic.totalCalls > 0) {
        items.push({
          label: `$(search-view-icon) Critic: ${critic.blockedTurns} blocked turn(s) / ${critic.totalCalls} call(s)`,
          description: critic.lastBlockedReason ? `Last block: ${critic.lastBlockedReason}` : '',
          detail: 'Critic-invoked LLM calls fire independently of main-loop requests.',
        });
      }
      items.push({
        label: '$(trash) Reset session spend',
        description: '',
        detail: '',
      });
      const picked = await window.showQuickPick(items, {
        title: 'SideCar — Session Spend (estimated)',
        placeHolder: 'Claude API session cost breakdown',
      });
      if (picked?.label.startsWith('$(trash)')) {
        spendTracker.reset();
        resetCriticStats();
        window.showInformationMessage('SideCar session spend + critic stats reset.');
      }
    }),
    commands.registerCommand('sidecar.resetSpend', () => {
      spendTracker.reset();
      window.showInformationMessage('SideCar session spend reset.');
    }),
    // Invalidate on config changes — health+circuit reset on backend switch
    workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('sidecar.model') ||
        e.affectsConfiguration('sidecar.baseUrl') ||
        e.affectsConfiguration('sidecar.apiKey')
      ) {
        healthStatus.reset();
        circuitBreaker.reset();
        renderStatusBar(healthStatus.get());
      }
    }),
  );
}

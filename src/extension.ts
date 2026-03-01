import * as vscode from 'vscode';
import { DiscogsColorThemePanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
  const provider = new DiscogsColorThemePanel(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('discogsColorTheme.open', () => {
      provider.openOrReveal();
    })
  );

  // Trigger auto-refresh logic (onOpen or start interval timer if configured)
  provider.startAutoRefresh();
}

export function deactivate() {}

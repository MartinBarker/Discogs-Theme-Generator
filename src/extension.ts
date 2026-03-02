import * as vscode from 'vscode';
import { DiscogsThemeGeneratorPanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
  const provider = new DiscogsThemeGeneratorPanel(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('discogsThemeGenerator.open', () => {
      provider.openOrReveal();
    })
  );

  // Trigger auto-refresh logic (onOpen or start interval timer if configured)
  provider.startAutoRefresh();
}

export function deactivate() {}

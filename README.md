# Discogs Color Theme

Generate color themes from Discogs album art. Pick a random vinyl release, extract colors from its cover, and apply the palette to your editor.

Works in **VS Code**, **Cursor**, and any editor that supports VS Code extensions.

---

## Quick Start

1. Install the extension (from VSIX or marketplace)
2. `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) → **Open Discogs Color Theme**
3. Click **From Discogs** — a random release is fetched and its colors become your theme

---

## Features

- **From Discogs** — fetches random vinyl releases and builds themes from album art
- **Generate Random** — random color palettes without Discogs
- **History** — browse and reload past themes
- **Auto-refresh** — optional interval or on workspace open
- **Scope** — apply to this window only or all windows

---

## Build VSIX

To create an installable `.vsix` file:

**1. Install the packaging tool** (once):

```bash
npm install -g @vscode/vsce
```

**2. Package the extension:**

```bash
vsce package
```

This produces a file like `discogs-color-theme-0.0.7.vsix` in the project root.

---

## Install from VSIX

```bash
# VS Code
code --install-extension discogs-color-theme-0.0.7.vsix

# Cursor
cursor --install-extension discogs-color-theme-0.0.7.vsix
```

Or: **Extensions** → **⋯** → **Install from VSIX…**

---

## Development

```bash
npm install
npm run watch
```

Press **F5** in VS Code or Cursor to launch the Extension Development Host.

---

## Requirements

- Node.js 18+
- VS Code 1.85+ or Cursor (any recent version)

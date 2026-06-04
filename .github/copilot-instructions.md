# Error Bell – VS Code Extension

A VS Code extension that monitors terminal commands and plays a sound whenever a command exits with an error, helping developers notice failed builds, tests, scripts, or deployments without constantly watching the terminal.

## Project Checklist

- [x] Clarify project requirements
- [ ] Scaffold the project
- [ ] Customize the project
- [ ] Install required extensions
- [ ] Compile the project
- [ ] Create and run task
- [ ] Launch the project
- [ ] Ensure documentation is complete

## Tech Stack

- TypeScript
- VS Code Extension API (`vscode.window.onDidCloseTerminal`, `vscode.window.onDidEndTerminalShellExecution`)
- npm

## Key Features

- Monitor terminal shell execution exit codes
- Play a configurable sound on non-zero exit codes
- Status bar indicator showing last exit code
- Toggle on/off via command palette

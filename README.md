# 🔔 Error Bell

[![Installs](https://img.shields.io/visual-studio-marketplace/i/MilanGarmora.error-bell?label=Installs&color=blue)](https://marketplace.visualstudio.com/items?itemName=MilanGarmora.error-bell)
[![Rating](https://img.shields.io/visual-studio-marketplace/stars/MilanGarmora.error-bell?label=Rating)](https://marketplace.visualstudio.com/items?itemName=MilanGarmora.error-bell&ssr=false#review-details)
[![GitHub Stars](https://img.shields.io/github/stars/DevMG7568/error-bell?style=social)](https://github.com/DevMG7568/error-bell)

**Never miss a failed build again.**

Error Bell is a VS Code and Cursor extension that listens to every terminal command you run and plays a sound the moment one exits with an error — so you can stay focused on your work instead of babysitting the terminal.

---

## Requirements

- **VS Code** `1.120.0` or newer
- **Shell integration** active in your terminal (enabled by default in VS Code for PowerShell, bash, zsh, and fish — see [Shell Integration docs](https://code.visualstudio.com/docs/terminal/shell-integration) if you use Git Bash, WSL, or a custom shell)
- **Windows:** built-in (uses PowerShell + Windows Media Player)
- **macOS:** built-in (uses `afplay`)
- **Linux:** `paplay` (PulseAudio) or `mpg123` or `ffplay` — at least one must be installed

---

## What It Does

Error Bell hooks into VS Code's terminal shell execution events. Every time a command finishes, it checks the exit code:

- **Non-zero exit code** → plays your configured error sound
- **Exit code 0** → plays your configured success sound (optional)
- **Quiet hours active** → stays silent regardless of exit code
- **Cooldown not elapsed** → skips the sound to prevent spam
- **Ignored exit codes** (e.g. `130` for Ctrl+C) → always silent

A status bar item in the bottom-right corner shows the current state at a glance and can be clicked to toggle the extension on or off.

When you open a terminal that doesn't have shell integration active, Error Bell will offer a setup guide so you can enable it — because without shell integration, exit codes cannot be detected.

---

## Settings

Open **Error Bell Settings** from the Command Palette (`Ctrl+Shift+P` → `Error Bell: Settings`) to configure everything through a clean UI. All settings are also available in VS Code's standard Settings editor.

### General

| Setting                   | Description                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Enable Error Bell**     | Master on/off switch for all sounds                                                      |
| **Explicit Sounds (18+)** | Unlocks adult/explicit sound categories in the sound pickers. Requires age confirmation. |

### Error Sound

| Setting                | Description                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Sound**              | The sound to play on failure. Options: `System Sound`, `Random`, `Selective Random`, any built-in meme sound, or a custom file. |
| **Volume**             | Playback volume from 0% (muted) to 100%.                                                                                        |
| **Cooldown**           | Minimum seconds that must pass between error sounds. Set to `0` for no limit.                                                   |
| **Ignored Exit Codes** | Comma-separated list of exit codes that never trigger a sound (default: `130` for Ctrl+C).                                      |

### Success Sound

| Setting   | Description                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sound** | Optional sound to play when a command exits successfully. Set to `Disabled` to turn it off, or choose `System Sound`, `Random`, `Selective Random`, or a custom file. |

### Quiet Hours

| Setting   | Description                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hours** | A time range (24h format) during which all sounds are silenced. Supports overnight ranges, e.g. `22:00` to `08:00`. Leave blank to disable. |

### Sound Picker Features

- **Random** — picks from all available sounds in that category on every trigger
- **Selective Random** — you choose a pool of sounds; Error Bell picks randomly from your pool
- **Custom sounds** — browse for any audio file (MP3, WAV, OGG, FLAC, M4A, AAC, WMA, AIFF, OPUS); name it and it appears in the picker with a delete button
- **Preview** — hover over any sound in the picker for 300 ms to preview it before committing

### Diagnostics

The **Terminal Support** button in Settings shows which currently open terminals have shell integration active and which do not, so you know exactly where error detection will work.

---

## Thank You

Thank you for using Error Bell! This extension was built out of a genuine need — running long builds and missing failures is frustrating, and a simple sound solves that entirely. I hope it saves you as much time as it saves me.

---

## Suggestions & Feedback

Have an idea, found a bug, or want a new sound category? I'd love to hear from you:

📬 **[devmg7568@gmail.com](mailto:devmg7568@gmail.com)**

All feedback is welcome — feature requests, UX improvements, platform-specific issues, or just a note to say it worked for you.

---

## Enjoying Error Bell?

If this extension saves you time, please consider **[leaving a ⭐ review on the Marketplace](https://marketplace.visualstudio.com/items?itemName=MilanGarmora.error-bell&ssr=false#review-details)** — it helps others discover it and keeps the project going. Thank you!

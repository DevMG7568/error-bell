import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { checkQuietHours, buildPlayCommand } from './utils';
import type { SoundOption } from './utils';

let statusBarItem: vscode.StatusBarItem;

// ─── Types ────────────────────────────────────────────────────────────────────

// SoundOption is defined in utils.ts and re-exported from there.

interface CustomSound {
	label: string;
	path: string;
}

const CUSTOM_SOUNDS_KEY = 'errorBell.customSounds';
const SUCCESS_CUSTOM_SOUNDS_KEY = 'errorBell.customSuccessSounds';
const ADULT_CONSENT_KEY = 'errorBell.adultConsented';
const SELECTIVE_POOL_KEY = 'errorBell.selectiveRandomPool';
const SUCCESS_SELECTIVE_POOL_KEY = 'errorBell.successSelectiveRandomPool';
const DELETE_BUTTON: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('trash'),
	tooltip: 'Remove this sound',
};

const CONFIGURE_BUTTON: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('settings-gear'),
	tooltip: 'Configure which sounds to include',
};

// ─── Config helpers ───────────────────────────────────────────────────────────

function getEnabled(): boolean {
	return vscode.workspace.getConfiguration('errorBell').get<boolean>('enabled', true);
}

function getSound(): SoundOption {
	return vscode.workspace.getConfiguration('errorBell').get<string>('sound', 'SystemSound');
}

function getVolume(): number {
	return vscode.workspace.getConfiguration('errorBell').get<number>('volume', 100);
}

function getCooldown(): number {
	return vscode.workspace.getConfiguration('errorBell').get<number>('cooldown', 3);
}

function getSuccessSound(): string {
	return vscode.workspace.getConfiguration('errorBell').get<string>('successSound', '');
}

function getIgnoredExitCodes(): number[] {
	return vscode.workspace.getConfiguration('errorBell').get<number[]>('ignoredExitCodes', [130]);
}

function isQuietHours(): boolean {
	const cfg = vscode.workspace.getConfiguration('errorBell');
	const start = cfg.get<string>('quietHoursStart', '');
	const end = cfg.get<string>('quietHoursEnd', '');
	return checkQuietHours(start, end, new Date());
}

// Timestamp (ms) of the last error sound played — used for cooldown enforcement
let lastErrorSoundAt = 0;
let lastSuccessSoundAt = 0;

function getCustomSounds(context: vscode.ExtensionContext): CustomSound[] {
	return context.globalState.get<CustomSound[]>(CUSTOM_SOUNDS_KEY, []);
}

function saveCustomSounds(context: vscode.ExtensionContext, sounds: CustomSound[]): Thenable<void> {
	return context.globalState.update(CUSTOM_SOUNDS_KEY, sounds);
}

function getCustomSuccessSounds(context: vscode.ExtensionContext): CustomSound[] {
	return context.globalState.get<CustomSound[]>(SUCCESS_CUSTOM_SOUNDS_KEY, []);
}

function saveCustomSuccessSounds(context: vscode.ExtensionContext, sounds: CustomSound[]): Thenable<void> {
	return context.globalState.update(SUCCESS_CUSTOM_SOUNDS_KEY, sounds);
}

function readSoundsFromDir(dir: string): CustomSound[] {
	try {
		return fs.readdirSync(dir)
			.filter((f: string) => /\.(mp3|wav|ogg|flac|m4a|aac|wma|aiff|opus)$/i.test(f))
			.map((f: string) => ({
				label: path.basename(f, path.extname(f)),
				path: path.join(dir, f),
			}));
	} catch {
		return [];
	}
}

function getBuiltInSounds(context: vscode.ExtensionContext): CustomSound[] {
	return readSoundsFromDir(vscode.Uri.joinPath(context.extensionUri, 'sounds').fsPath);
}

function getIndianSounds(context: vscode.ExtensionContext): CustomSound[] {
	return readSoundsFromDir(vscode.Uri.joinPath(context.extensionUri, 'sounds-indian').fsPath);
}

function getAdultSounds(context: vscode.ExtensionContext): CustomSound[] {
	return readSoundsFromDir(vscode.Uri.joinPath(context.extensionUri, 'sounds-adult').fsPath);
}

function getAdultIndianSounds(context: vscode.ExtensionContext): CustomSound[] {
	return readSoundsFromDir(vscode.Uri.joinPath(context.extensionUri, 'sounds-adult-indian').fsPath);
}

function getSuccessSounds(context: vscode.ExtensionContext): CustomSound[] {
	return readSoundsFromDir(vscode.Uri.joinPath(context.extensionUri, 'sounds-success').fsPath);
}

function getAdultSuccessSounds(context: vscode.ExtensionContext): CustomSound[] {
	return readSoundsFromDir(vscode.Uri.joinPath(context.extensionUri, 'sounds-success-adult').fsPath);
}

function hasAdultConsent(context: vscode.ExtensionContext): boolean {
	return context.globalState.get<boolean>(ADULT_CONSENT_KEY, false);
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'error-bell.toggle';
	updateStatusBar();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	context.subscriptions.push(
		vscode.commands.registerCommand('error-bell.toggle', () => {
			vscode.workspace.getConfiguration('errorBell').update('enabled', !getEnabled(), vscode.ConfigurationTarget.Global);
			updateStatusBar();
		}),

		vscode.commands.registerCommand('error-bell.openSettings', () => openSettingsPanel(context)),

		// Detect new terminals opened without shell integration
		vscode.window.onDidOpenTerminal(terminal => handleTerminalOpened(terminal, context)),

		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('errorBell')) {
				updateStatusBar();
			}
		}),

		vscode.window.onDidEndTerminalShellExecution((event) => {
			const exitCode = event.exitCode;
			if (exitCode === undefined) { return; }
			if (getEnabled() && exitCode !== 0) {
				if (getIgnoredExitCodes().includes(exitCode)) { return; }
				playErrorSound(context);
			} else if (getEnabled() && exitCode === 0) {
				playSuccessSound(context);
			}
		}),
	);

	// Open settings on fresh install or reinstall, but NOT on version upgrades.
	// globalState persists across uninstall/reinstall, so we use the mtime of
	// the compiled extension file as a proxy — on every fresh install/reinstall
	// the file is newly copied with a new timestamp, while a normal restart or
	// a version upgrade leaves the already-stored mtime logic distinguishable.
	const INSTALL_MTIME_KEY = 'errorBell.extensionFileMtime';
	const INSTALL_VERSION_KEY = 'errorBell.installedVersion';
	const currentMtime = fs.statSync(__filename).mtimeMs.toString();
	const currentVersion = context.extension.packageJSON.version as string;
	const storedMtime = context.globalState.get<string>(INSTALL_MTIME_KEY);
	const storedVersion = context.globalState.get<string>(INSTALL_VERSION_KEY);
	const isFirstInstall = !storedMtime;
	const isReinstall = storedMtime !== currentMtime && storedVersion === currentVersion;
	if (isFirstInstall || isReinstall) {
		openSettingsPanel(context);
	}
	context.globalState.update(INSTALL_MTIME_KEY, currentMtime);
	context.globalState.update(INSTALL_VERSION_KEY, currentVersion);

	// Check terminals already open when extension activates
	vscode.window.terminals.forEach(terminal => handleTerminalOpened(terminal, context, 0));
}

// ─── Terminal support ────────────────────────────────────────────────────────

const NOTIFIED_SHELLS_KEY = 'errorBell.notifiedShells';

interface ShellGuide {
	pattern: RegExp;
	name: string;
	canEnable: boolean;
	guide: string;
}

const SHELL_GUIDES: ShellGuide[] = [
	{
		pattern: /bash|git.?bash/i,
		name: 'Git Bash',
		canEnable: true,
		guide:
			'Add the following line to your ~/.bashrc:\n\n' +
			'[[ "$TERM_PROGRAM" == "vscode" ]] && . "$(code --locate-shell-integration-path bash)"\n\n' +
			'Then restart the terminal.',
	},
	{
		pattern: /cmd|command.?prompt/i,
		name: 'Command Prompt',
		canEnable: false,
		guide: 'Command Prompt does not support shell integration.\nUse PowerShell or Git Bash instead for full Error Bell support.',
	},
	{
		pattern: /wsl/i,
		name: 'WSL',
		canEnable: true,
		guide:
			'Add the following to your ~/.bashrc (bash) or ~/.zshrc (zsh) inside WSL:\n\n' +
			'[[ "$TERM_PROGRAM" == "vscode" ]] && . "$(code --locate-shell-integration-path bash)"\n\n' +
			'Then restart the WSL terminal.',
	},
	{
		pattern: /fish/i,
		name: 'Fish',
		canEnable: true,
		guide:
			'Add the following to ~/.config/fish/config.fish:\n\n' +
			'string match -q "$TERM_PROGRAM" "vscode"; and . (code --locate-shell-integration-path fish)\n\n' +
			'Then restart the terminal.',
	},
];

function detectShellGuide(terminalName: string): ShellGuide | undefined {
	return SHELL_GUIDES.find(g => g.pattern.test(terminalName));
}

function handleTerminalOpened(terminal: vscode.Terminal, context: vscode.ExtensionContext, delay = 2000): void {
	setTimeout(() => {
		if (terminal.shellIntegration) { return; }
		const guide = detectShellGuide(terminal.name);
		if (!guide) { return; }
		const notified = context.globalState.get<string[]>(NOTIFIED_SHELLS_KEY, []);
		if (notified.includes(guide.name)) { return; }
		const actions = guide.canEnable
			? ['Show Setup Guide', "Don't show again"]
			: ['Dismiss', "Don't show again"];
		vscode.window.showWarningMessage(
			`Error Bell: ${guide.name} doesn't have shell integration active — error detection won't work in this terminal.`,
			...actions
		).then(selection => {
			if (selection === 'Show Setup Guide') {
				vscode.window.showInformationMessage(
					`Error Bell: ${guide.name} Setup`,
					{ modal: true, detail: guide.guide },
					'OK'
				);
			}
			if (selection === "Don't show again") {
				context.globalState.update(NOTIFIED_SHELLS_KEY, [...notified, guide.name]);
			}
		});
	}, delay);
}

function showTerminalSupportStatus(): void {
	const terminals = vscode.window.terminals;
	if (terminals.length === 0) {
		vscode.window.showInformationMessage('Error Bell: No terminals are currently open.');
		return;
	}
	const lines = terminals.map(t => {
		const icon = t.shellIntegration ? '✔' : '✘';
		const status = t.shellIntegration ? 'Shell integration active' : 'No shell integration';
		return `${icon}  ${t.name.padEnd(24)} ${status}`;
	});
	vscode.window.showInformationMessage(
		'Error Bell — Terminal Support',
		{ modal: true, detail: lines.join('\n') },
		'OK'
	);
}



interface SoundPickItem extends vscode.QuickPickItem {
	kind?: vscode.QuickPickItemKind;
	soundId: SoundOption | '__add__';
}

function buildItems(context: vscode.ExtensionContext): SoundPickItem[] {
	const builtIn = getBuiltInSounds(context);
	const indian = getIndianSounds(context);
	const custom = getCustomSounds(context);
	const adult = getAdultSounds(context);
	const adultIndian = getAdultIndianSounds(context);
	const consented = hasAdultConsent(context);
	const items: SoundPickItem[] = [
		{ label: '$(bell) System Sound', description: 'Default OS alert sound', soundId: 'SystemSound' },
		{ label: '$(sync) Random', description: 'Pick randomly from all available sounds', soundId: 'Random' },
		{
			label: '$(list-unordered) Selective Random',
			description: (() => {
				const pool = context.globalState.get<string[]>(SELECTIVE_POOL_KEY, []);
				return pool.length > 0 ? `${pool.length} sound${pool.length === 1 ? '' : 's'} in pool` : 'No sounds selected yet — click ⚙ to configure';
			})(),
			soundId: 'SelectiveRandom',
			buttons: [CONFIGURE_BUTTON],
		},
	];

	if (builtIn.length > 0) {
		items.push({ label: 'Global Meme Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '__add__' });
		for (const s of builtIn) {
			items.push({ label: `$(music) ${s.label}`, description: 'Global meme', soundId: s.path });
		}
	}

	if (indian.length > 0) {
		items.push({ label: 'Indian Meme Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '__add__' });
		for (const s of indian) {
			items.push({ label: `$(music) ${s.label}`, description: 'Indian meme', soundId: s.path });
		}
	}

	if (custom.length > 0) {
		items.push({ label: 'My Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '__add__' });
		for (const s of custom) {
			items.push({ label: `$(music) ${s.label}`, description: s.path, soundId: s.path });
		}
	}

	// ── Explicit sections — only shown after consent ─────────────────────────
	if (consented) {
		if (adult.length > 0) {
			items.push({ label: 'Explicit Global Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '__add__' });
			for (const s of adult) {
				items.push({ label: `$(music) ${s.label}`, description: 'Explicit · Global', soundId: s.path });
			}
		}
		if (adultIndian.length > 0) {
			items.push({ label: 'Explicit Indian Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '__add__' });
			for (const s of adultIndian) {
				items.push({ label: `$(music) ${s.label}`, description: 'Explicit · Indian', soundId: s.path });
			}
		}
	}

	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, soundId: '__add__' });
	items.push({ label: '$(add) Add custom sound…', description: 'Browse for an audio file (wav, mp3, ogg, flac, m4a…)', soundId: '__add__' });

	return items;
}

function showSoundPicker(context: vscode.ExtensionContext): void {
	const qp = vscode.window.createQuickPick<SoundPickItem>();
	qp.title = 'Error Bell: Choose your error sound';
	qp.placeholder = 'Pause on a sound to preview it • Enter to confirm';
	qp.ignoreFocusOut = true;

	const refresh = () => {
		const current = getSound();
		qp.items = buildItems(context);
		qp.activeItems = qp.items.filter(i => i.soundId === current);
	};
	refresh();

	// Debounced preview — only plays after user pauses for 200ms
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	qp.onDidChangeActive((active) => {
		if (previewTimer) {
			clearTimeout(previewTimer);
		}
		const id = active[0]?.soundId;
		if (id && id !== '__add__' && id !== '__unlock_adult__' && id !== '__hide_adult__' && id !== 'Random' && id !== 'SelectiveRandom' && id !== 'SystemSound') {
			previewTimer = setTimeout(() => {
				previewSound(id);
			}, 300);
		}
	});

	// Trash button on custom items; gear button on Selective Random
	qp.onDidTriggerItemButton(async ({ item, button }) => {
		if (button === CONFIGURE_BUTTON) {
			qp.hide();
			await showSelectiveRandomConfigurator(context);
			showSoundPicker(context);
			return;
		}
		// Trash button
		const sounds = getCustomSounds(context).filter(s => s.path !== item.soundId);
		await saveCustomSounds(context, sounds);
		if (getSound() === item.soundId) {
			await vscode.workspace.getConfiguration('errorBell').update('sound', 'SystemSound', vscode.ConfigurationTarget.Global);
		}
		refresh();
	});

	qp.onDidAccept(async () => {
		const selected = qp.selectedItems[0];
		if (!selected) { return; }

		if (selected.soundId === 'SelectiveRandom') {
			if (previewTimer) { clearTimeout(previewTimer); }
			await vscode.workspace.getConfiguration('errorBell').update('sound', 'SelectiveRandom', vscode.ConfigurationTarget.Global);
			context.globalState.update('errorBell.soundChosen', true);
			qp.dispose();
			// If pool is empty, immediately open configurator
			const pool = context.globalState.get<string[]>(SELECTIVE_POOL_KEY, []);
			if (pool.length === 0) {
				await showSelectiveRandomConfigurator(context);
			}
			return;
		}

		if (selected.soundId === '__add__') {
			qp.hide();
			await addCustomSound(context);
			showSoundPicker(context);
			return;
		}

		if (previewTimer) { clearTimeout(previewTimer); }
		await vscode.workspace.getConfiguration('errorBell').update('sound', selected.soundId, vscode.ConfigurationTarget.Global);
		context.globalState.update('errorBell.soundChosen', true);
		qp.dispose();
	});

	qp.onDidHide(() => {
		if (previewTimer) { clearTimeout(previewTimer); }
		context.globalState.update('errorBell.soundChosen', true);
		qp.dispose();
	});

	qp.show();
}

function showSuccessSoundPicker(context: vscode.ExtensionContext): void {
	interface SuccessPickItem extends vscode.QuickPickItem {
		kind?: vscode.QuickPickItemKind;
		soundId: string;
	}

	const buildSuccessItems = (): SuccessPickItem[] => {
		const successSounds = getSuccessSounds(context);
		const adultSuccess = getAdultSuccessSounds(context);
		const customSuccess = getCustomSuccessSounds(context);
		const c = hasAdultConsent(context);
		const successPool = context.globalState.get<string[]>(SUCCESS_SELECTIVE_POOL_KEY, []);

		const items: SuccessPickItem[] = [
			{ label: '$(circle-slash) Disabled', description: 'No sound on success', soundId: '' },
			{ label: '$(bell) System Sound', description: 'Default OS alert sound', soundId: 'SystemSound' },
			{ label: '$(sync) Random', description: 'Pick randomly from all available success sounds', soundId: 'Random' },
			{
				label: '$(list-unordered) Selective Random',
				description: successPool.length > 0 ? `${successPool.length} sound${successPool.length === 1 ? '' : 's'} in pool` : 'No sounds selected yet — click ⚙ to configure',
				soundId: 'SelectiveRandom',
				buttons: [CONFIGURE_BUTTON],
			},
		];
		if (successSounds.length > 0) {
			items.push({ label: 'Success Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '' });
			for (const s of successSounds) {
				items.push({ label: `$(music) ${s.label}`, description: 'Success', soundId: s.path });
			}
		}
		if (c && adultSuccess.length > 0) {
			items.push({ label: 'Explicit Success Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '' });
			for (const s of adultSuccess) {
				items.push({ label: `$(music) ${s.label}`, description: 'Explicit · Success', soundId: s.path });
			}
		}
		if (customSuccess.length > 0) {
			items.push({ label: 'My Success Sounds', kind: vscode.QuickPickItemKind.Separator, soundId: '' });
			for (const s of customSuccess) {
				items.push({ label: `$(music) ${s.label}`, description: s.path, soundId: s.path, buttons: [DELETE_BUTTON] });
			}
		}
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, soundId: '' });
		items.push({ label: '$(add) Add custom success sound…', description: 'Browse for an audio file', soundId: '__add_success__' });
		return items;
	};

	const qp = vscode.window.createQuickPick<SuccessPickItem>();
	qp.title = 'Error Bell: Choose your success sound';
	qp.placeholder = 'Pause on a sound to preview it • Enter to confirm';
	qp.ignoreFocusOut = true;

	const refresh = () => {
		const current = getSuccessSound();
		qp.items = buildSuccessItems();
		qp.activeItems = qp.items.filter(i => i.soundId === current);
	};
	refresh();

	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	qp.onDidChangeActive((active) => {
		if (previewTimer) { clearTimeout(previewTimer); }
		const id = active[0]?.soundId;
		if (id && id !== '' && id !== '__unlock_adult__' && id !== '__hide_adult__' && id !== 'Random' && id !== 'SystemSound') {
			previewTimer = setTimeout(() => previewSound(id), 300);
		}
	});

	// Trash button on custom items; gear button on Selective Random
	qp.onDidTriggerItemButton(async ({ item, button }) => {
		if (button === CONFIGURE_BUTTON) {
			qp.hide();
			await showSuccessSelectiveRandomConfigurator(context);
			showSuccessSoundPicker(context);
			return;
		}
		// Trash button — remove from custom success sounds
		const updated = getCustomSuccessSounds(context).filter(s => s.path !== item.soundId);
		await saveCustomSuccessSounds(context, updated);
		if (getSuccessSound() === item.soundId) {
			await vscode.workspace.getConfiguration('errorBell').update('successSound', '', vscode.ConfigurationTarget.Global);
		}
		refresh();
	});

	qp.onDidAccept(async () => {
		const selected = qp.selectedItems[0];
		if (!selected) { return; }

		if (selected.soundId === 'SelectiveRandom') {
			if (previewTimer) { clearTimeout(previewTimer); }
			await vscode.workspace.getConfiguration('errorBell').update('successSound', 'SelectiveRandom', vscode.ConfigurationTarget.Global);
			qp.dispose();
			const pool = context.globalState.get<string[]>(SUCCESS_SELECTIVE_POOL_KEY, []);
			if (pool.length === 0) {
				await showSuccessSelectiveRandomConfigurator(context);
			}
			return;
		}

		if (selected.soundId === '__add_success__') {
			qp.hide();
			await addCustomSuccessSound(context);
			showSuccessSoundPicker(context);
			return;
		}

		if (previewTimer) { clearTimeout(previewTimer); }
		await vscode.workspace.getConfiguration('errorBell').update('successSound', selected.soundId, vscode.ConfigurationTarget.Global);
		qp.dispose();
	});

	qp.onDidHide(() => {
		if (previewTimer) { clearTimeout(previewTimer); }
		qp.dispose();
	});

	qp.show();
}

async function showSelectiveRandomConfigurator(context: vscode.ExtensionContext): Promise<void> {
	const builtIn = getBuiltInSounds(context);
	const indian = getIndianSounds(context);
	const custom = getCustomSounds(context);
	const adult = hasAdultConsent(context) ? getAdultSounds(context) : [];
	const adultIndian = hasAdultConsent(context) ? getAdultIndianSounds(context) : [];
	const savedPool = context.globalState.get<string[]>(SELECTIVE_POOL_KEY, []);

	interface PoolItem extends vscode.QuickPickItem {
		soundId: string;
	}

	const makeItems = (sounds: CustomSound[], sectionLabel: string, desc: string): PoolItem[] => {
		if (sounds.length === 0) { return []; }
		const sep: PoolItem = { label: sectionLabel, kind: vscode.QuickPickItemKind.Separator, soundId: '' };
		return [sep, ...sounds.map(s => ({
			label: `$(music) ${s.label}`,
			description: desc,
			soundId: s.path,
		}))];
	};

	const allItems: PoolItem[] = [
		{ label: '$(bell) System Sound', description: 'Default OS alert sound', soundId: 'SystemSound' },
		...makeItems(builtIn, 'Global Meme Sounds', 'Global meme'),
		...makeItems(indian, 'Indian Meme Sounds', 'Indian meme'),
		...makeItems(custom, 'My Sounds', 'Custom'),
		...makeItems(adult, 'Explicit Global Sounds', 'Explicit · Global'),
		...makeItems(adultIndian, 'Explicit Indian Sounds', 'Explicit · Indian'),
	];

	const qp = vscode.window.createQuickPick<PoolItem>();
	qp.title = 'Error Bell: Configure Selective Random Pool';
	qp.placeholder = 'Check sounds to include in your random pool • Enter to save';
	qp.canSelectMany = true;
	qp.ignoreFocusOut = true;
	qp.items = allItems;
	qp.selectedItems = allItems.filter(i => savedPool.includes(i.soundId));

	await new Promise<void>(resolve => {
		qp.onDidAccept(async () => {
			const pool = qp.selectedItems.map(i => i.soundId);
			await context.globalState.update(SELECTIVE_POOL_KEY, pool);
			qp.dispose();
			resolve();
		});
		qp.onDidHide(() => { qp.dispose(); resolve(); });
		qp.show();
	});
}

async function showSuccessSelectiveRandomConfigurator(context: vscode.ExtensionContext): Promise<void> {
	const successSounds = getSuccessSounds(context);
	const adultSuccess = hasAdultConsent(context) ? getAdultSuccessSounds(context) : [];
	const customSuccess = getCustomSuccessSounds(context);
	const savedPool = context.globalState.get<string[]>(SUCCESS_SELECTIVE_POOL_KEY, []);

	interface PoolItem extends vscode.QuickPickItem { soundId: string; }

	const makeItems = (sounds: CustomSound[], sectionLabel: string, desc: string): PoolItem[] => {
		if (sounds.length === 0) { return []; }
		const sep: PoolItem = { label: sectionLabel, kind: vscode.QuickPickItemKind.Separator, soundId: '' };
		return [sep, ...sounds.map(s => ({
			label: `$(music) ${s.label}`,
			description: desc,
			soundId: s.path,
		}))];
	};

	const allItems: PoolItem[] = [
		...makeItems(successSounds, 'Success Sounds', 'Success'),
		...makeItems(adultSuccess, 'Explicit Success Sounds', 'Explicit · Success'),
		...makeItems(customSuccess, 'My Success Sounds', 'Custom'),
	];

	if (allItems.length === 0) {
		vscode.window.showInformationMessage('No success sounds found. Add sounds to the sounds-success/ folder or add custom sounds first.');
		return;
	}

	const qp = vscode.window.createQuickPick<PoolItem>();
	qp.title = 'Error Bell: Configure Success Selective Random Pool';
	qp.placeholder = 'Check sounds to include in your random pool • Enter to save';
	qp.canSelectMany = true;
	qp.ignoreFocusOut = true;
	qp.items = allItems;
	qp.selectedItems = allItems.filter(i => savedPool.includes(i.soundId));

	await new Promise<void>(resolve => {
		qp.onDidAccept(async () => {
			const pool = qp.selectedItems.map(i => i.soundId);
			await context.globalState.update(SUCCESS_SELECTIVE_POOL_KEY, pool);
			qp.dispose();
			resolve();
		});
		qp.onDidHide(() => { qp.dispose(); resolve(); });
		qp.show();
	});
}

async function addCustomSound(context: vscode.ExtensionContext): Promise<void> {
	const uris = await vscode.window.showOpenDialog({
		title: 'Select a sound file',
		filters: { 'Audio files': ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff', 'opus'] },
		canSelectMany: false,
	});

	if (!uris || uris.length === 0) { return; }

	const filePath = uris[0].fsPath;
	const defaultLabel = path.basename(filePath, path.extname(filePath));

	const label = await vscode.window.showInputBox({
		title: 'Name this sound',
		value: defaultLabel,
		prompt: 'Give your sound a display name',
		validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
	});

	if (!label) { return; }

	const sounds = getCustomSounds(context);
	sounds.push({ label: label.trim(), path: filePath });
	await saveCustomSounds(context, sounds);

	// Auto-select the newly added sound
	await vscode.workspace.getConfiguration('errorBell').update('sound', filePath, vscode.ConfigurationTarget.Global);
}

async function addCustomSuccessSound(context: vscode.ExtensionContext): Promise<void> {
	const uris = await vscode.window.showOpenDialog({
		title: 'Select a success sound file',
		filters: { 'Audio files': ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff', 'opus'] },
		canSelectMany: false,
	});

	if (!uris || uris.length === 0) { return; }

	const filePath = uris[0].fsPath;
	const defaultLabel = path.basename(filePath, path.extname(filePath));

	const label = await vscode.window.showInputBox({
		title: 'Name this success sound',
		value: defaultLabel,
		prompt: 'Give your sound a display name',
		validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
	});

	if (!label) { return; }

	const sounds = getCustomSuccessSounds(context);
	sounds.push({ label: label.trim(), path: filePath });
	await saveCustomSuccessSounds(context, sounds);

	// Auto-select the newly added sound
	await vscode.workspace.getConfiguration('errorBell').update('successSound', filePath, vscode.ConfigurationTarget.Global);
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function updateStatusBar(): void {
	const vol = getVolume();
	const volLabel = vol === 0 ? 'Muted' : `Volume ${vol}%`;
	if (!getEnabled()) {
		statusBarItem.text = '$(bell-slash) Error Bell: Off';
		statusBarItem.tooltip = 'Error Bell is disabled. Click to enable.';
		statusBarItem.backgroundColor = undefined;
	} else if (isQuietHours()) {
		const end = vscode.workspace.getConfiguration('errorBell').get<string>('quietHoursEnd', '');
		statusBarItem.text = '$(clock) Error Bell: Quiet';
		statusBarItem.tooltip = `Quiet hours active — sounds muted until ${end}. Click to toggle Error Bell.`;
		statusBarItem.backgroundColor = undefined;
	} else {
		statusBarItem.text = '$(bell) Error Bell: On';
		statusBarItem.tooltip = `Error Bell is enabled · ${volLabel}. Click to disable.`;
		statusBarItem.backgroundColor = undefined;
	}
}

// ─── Playback ─────────────────────────────────────────────────────────────────

function previewSound(soundId: SoundOption): void {
	exec(buildPlayCommand(soundId, getVolume()), () => { });
}

function playErrorSound(context: vscode.ExtensionContext): void {
	if (isQuietHours()) { return; }
	const cooldownMs = getCooldown() * 1000;
	if (cooldownMs > 0 && Date.now() - lastErrorSoundAt < cooldownMs) {
		return; // still within cooldown window
	}
	lastErrorSoundAt = Date.now();

	let sound = getSound();
	if (sound === 'SelectiveRandom') {
		const pool = context.globalState.get<string[]>(SELECTIVE_POOL_KEY, []);
		if (pool.length === 0) { return; }
		sound = pool[Math.floor(Math.random() * pool.length)];
	} else if (sound === 'Random') {
		const all: SoundOption[] = [
			'SystemSound',
			...getBuiltInSounds(context).map(s => s.path),
			...getIndianSounds(context).map(s => s.path),
			...getCustomSounds(context).map(s => s.path),
			...(hasAdultConsent(context) ? getAdultSounds(context).map(s => s.path) : []),
			...(hasAdultConsent(context) ? getAdultIndianSounds(context).map(s => s.path) : []),
		];
		sound = all[Math.floor(Math.random() * all.length)];
	}
	exec(buildPlayCommand(sound, getVolume()), () => { });
}

function playSuccessSound(context: vscode.ExtensionContext): void {
	const successSound = getSuccessSound();
	if (!successSound) { return; }
	if (isQuietHours()) { return; }
	const cooldownMs = getCooldown() * 1000;
	if (cooldownMs > 0 && Date.now() - lastSuccessSoundAt < cooldownMs) { return; }
	lastSuccessSoundAt = Date.now();

	// Block explicit success sounds if no consent
	const adultSuccessDir = vscode.Uri.joinPath(context.extensionUri, 'sounds-success-adult').fsPath;
	if (!hasAdultConsent(context) && successSound !== 'Random' && successSound !== 'SelectiveRandom' && successSound !== 'SystemSound') {
		if (successSound.startsWith(adultSuccessDir)) { return; }
	}

	let sound: SoundOption = successSound;
	if (successSound === 'Random') {
		const all: SoundOption[] = [
			...getSuccessSounds(context).map(s => s.path),
			...getCustomSuccessSounds(context).map(s => s.path),
			...(hasAdultConsent(context) ? getAdultSuccessSounds(context).map(s => s.path) : []),
		];
		if (all.length === 0) { return; }
		sound = all[Math.floor(Math.random() * all.length)];
	} else if (successSound === 'SelectiveRandom') {
		const pool = context.globalState.get<string[]>(SUCCESS_SELECTIVE_POOL_KEY, []);
		if (pool.length === 0) { return; }
		sound = pool[Math.floor(Math.random() * pool.length)];
	}
	exec(buildPlayCommand(sound, getVolume()), () => { });
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

let settingsPanel: vscode.WebviewPanel | undefined;

function openSettingsPanel(context: vscode.ExtensionContext): void {
	if (settingsPanel) {
		settingsPanel.reveal();
		return;
	}

	settingsPanel = vscode.window.createWebviewPanel(
		'errorBellSettings',
		'Error Bell — Settings',
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true },
	);

	const sendConfig = () => {
		const cfg = vscode.workspace.getConfiguration('errorBell');
		settingsPanel?.webview.postMessage({
			type: 'update',
			config: {
				enabled: getEnabled(),
				adultConsented: hasAdultConsent(context),
				sound: getSound(),
				successSound: getSuccessSound(),
				volume: getVolume(),
				cooldown: getCooldown(),
				ignoredExitCodes: getIgnoredExitCodes(),
				quietHoursStart: cfg.get<string>('quietHoursStart', ''),
				quietHoursEnd: cfg.get<string>('quietHoursEnd', ''),
			},
		});
	};

	const sendSoundList = () => {
		const consented = hasAdultConsent(context);
		settingsPanel?.webview.postMessage({
			type: 'soundList',
			lists: {
				builtIn: getBuiltInSounds(context),
				indian: getIndianSounds(context),
				adult: consented ? getAdultSounds(context) : [],
				adultIndian: consented ? getAdultIndianSounds(context) : [],
				custom: getCustomSounds(context),
				success: getSuccessSounds(context),
				adultSuccess: consented ? getAdultSuccessSounds(context) : [],
				consented,
			},
		});
	};

	settingsPanel.webview.html = getSettingsHtml();

	settingsPanel.webview.onDidReceiveMessage(async (msg) => {
		const cfg = vscode.workspace.getConfiguration('errorBell');
		switch (msg.type) {
			case 'toggle':
				await cfg.update('enabled', !getEnabled(), vscode.ConfigurationTarget.Global);
				break;
			case 'changeSound':
				await showSoundPicker(context);
				break;
			case 'changeSuccessSound':
				await showSuccessSoundPicker(context);
				break;
			case 'setSoundDirect':
				await cfg.update('sound', msg.value || 'SystemSound', vscode.ConfigurationTarget.Global);
				break;
			case 'setSuccessSoundDirect':
				await cfg.update('successSound', msg.value, vscode.ConfigurationTarget.Global);
				break;
			case 'browseSuccessSound': {
				const result = await vscode.window.showOpenDialog({
					canSelectMany: false,
					title: 'Select a success sound file',
					filters: { 'Audio files': ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff', 'opus'] },
				});
				if (result && result[0]) {
					await cfg.update('successSound', result[0].fsPath, vscode.ConfigurationTarget.Global);
				}
				break;
			}
			case 'setVolume':
				await cfg.update('volume', msg.value, vscode.ConfigurationTarget.Global);
				break;
			case 'setCooldown':
				await cfg.update('cooldown', Math.max(0, Math.min(60, msg.value)), vscode.ConfigurationTarget.Global);
				break;
			case 'setIgnoredCodes':
				await cfg.update('ignoredExitCodes', msg.value, vscode.ConfigurationTarget.Global);
				break;
			case 'setQuietHours':
				await cfg.update('quietHoursStart', msg.start, vscode.ConfigurationTarget.Global);
				await cfg.update('quietHoursEnd', msg.end, vscode.ConfigurationTarget.Global);
				break;
			case 'showTerminalSupport':
				showTerminalSupportStatus();
				break;
			case 'toggleAdult': {
				if (msg.value) {
					const answer = await vscode.window.showWarningMessage(
						'18+ Adult Content',
						{
							modal: true,
							detail:
								'This section contains sounds with adult humor, explicit language, or mature content.\n\n' +
								'By proceeding you confirm that:\n' +
								' • You are 18 years of age or older\n' +
								' • You consent to hearing adult/explicit audio content\n' +
								' • You are in an appropriate environment to do so',
						},
						'Yes, I am 18+ — Unlock',
						'Cancel'
					);
					if (answer === 'Yes, I am 18+ — Unlock') {
						await context.globalState.update(ADULT_CONSENT_KEY, true);
					}
				} else {
					const answer = await vscode.window.showWarningMessage(
						'Hide Explicit Sounds',
						{
							modal: true,
							detail: 'This will revoke your consent and remove all explicit sounds from every list, including the Selective Random pool.\n\nYou can unlock them again at any time.',
						},
						'Yes, Hide Explicit Sounds',
						'Cancel'
					);
					if (answer === 'Yes, Hide Explicit Sounds') {
						await context.globalState.update(ADULT_CONSENT_KEY, false);
						const explicitPaths = new Set([
							...getAdultSounds(context).map(s => s.path),
							...getAdultIndianSounds(context).map(s => s.path),
							...getAdultSuccessSounds(context).map(s => s.path),
						]);
						const pool = context.globalState.get<string[]>(SELECTIVE_POOL_KEY, []);
						await context.globalState.update(SELECTIVE_POOL_KEY, pool.filter(p => !explicitPaths.has(p)));
						const successPool = context.globalState.get<string[]>(SUCCESS_SELECTIVE_POOL_KEY, []);
						await context.globalState.update(SUCCESS_SELECTIVE_POOL_KEY, successPool.filter(p => !explicitPaths.has(p)));
						if (explicitPaths.has(getSound())) {
							await vscode.workspace.getConfiguration('errorBell').update('sound', 'SystemSound', vscode.ConfigurationTarget.Global);
						}
						if (explicitPaths.has(getSuccessSound())) {
							await vscode.workspace.getConfiguration('errorBell').update('successSound', '', vscode.ConfigurationTarget.Global);
						}
					}
				}
				sendConfig();
				sendSoundList();
				break;
			}
		}
	});

	const configSub = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('errorBell') && settingsPanel) {
			sendConfig();
			sendSoundList();
		}
	});

	settingsPanel.onDidDispose(() => {
		settingsPanel = undefined;
		configSub.dispose();
	});

	setTimeout(() => { sendConfig(); sendSoundList(); }, 150);
}

function getSettingsHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Error Bell Settings</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{padding:24px 32px 56px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:660px;margin:0 auto}
h1{font-size:1.35em;font-weight:600;margin-bottom:28px;display:flex;align-items:center;gap:10px}
.section{margin-bottom:32px}
.section-title{font-size:.72em;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-foreground);opacity:.55;margin-bottom:4px;padding-bottom:6px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.2))}
.row{display:flex;align-items:center;justify-content:space-between;padding:10px 2px;gap:20px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.08))}
.row:last-child{border-bottom:none}
.lbl-wrap{flex:1;min-width:0}
.lbl{font-weight:400}
.desc{font-size:.85em;color:var(--vscode-descriptionForeground);margin-top:3px;line-height:1.4}
.ctrl{flex-shrink:0}
/* Toggle */
.tog{position:relative;display:inline-flex;align-items:center;cursor:pointer}
.tog input{opacity:0;width:0;height:0;position:absolute}
.track{width:42px;height:24px;background:var(--vscode-input-border,rgba(128,128,128,.4));border-radius:12px;transition:background .2s;position:relative}
.thumb{position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.tog input:checked~.track{background:var(--vscode-button-background,#0e639c)}
.tog input:checked~.track .thumb{transform:translateX(18px)}
.tog input:focus-visible~.track{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
/* Buttons */
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:2px;padding:5px 12px;cursor:pointer;font-size:var(--vscode-font-size);font-family:var(--vscode-font-family);white-space:nowrap}
button:hover{background:var(--vscode-button-hoverBackground)}
button.sec{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4))}
button.sec:hover{background:var(--vscode-list-hoverBackground,rgba(128,128,128,.1))}
/* Inputs */
input[type=text],input[type=number],input[type=time]{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;padding:5px 8px;font-size:var(--vscode-font-size);font-family:var(--vscode-font-family);outline:none}
input[type=text]:focus,input[type=number]:focus,input[type=time]:focus{border-color:var(--vscode-focusBorder)}
input[type=number]{width:68px;text-align:center}
input[type=time]{width:96px}
input[type=text]{width:150px}
/* Volume slider */
.vol-wrap{display:flex;align-items:center;gap:10px}
input[type=range]{-webkit-appearance:none;appearance:none;width:150px;height:4px;background:var(--vscode-input-border,rgba(128,128,128,.4));border-radius:2px;outline:none;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;background:var(--vscode-button-background,#0e639c);border-radius:50%}
.vol-val{width:38px;text-align:right;font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground)}
/* Sound chip */
.sound-chip{display:inline-flex;align-items:center;gap:8px}
.sound-name{background:var(--vscode-badge-background,rgba(128,128,128,.15));color:var(--vscode-badge-foreground,var(--vscode-foreground));border-radius:10px;padding:3px 11px;font-size:.9em;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Quiet hours */
.quiet-pair{display:flex;align-items:center;gap:8px}
.quiet-pair span{opacity:.5;font-size:.85em}
</style>
</head>
<body>
<h1><span>🔔</span> Error Bell Settings</h1>

<div class="section">
  <div class="section-title">General</div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Enable Error Bell</div>
      <div class="desc">Play a sound when a terminal command exits with a non-zero code</div>
    </div>
    <div class="ctrl">
      <label class="tog">
        <input type="checkbox" id="enabled">
        <div class="track"><div class="thumb"></div></div>
      </label>
    </div>
  </div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Explicit Sounds (18+)</div>
      <div class="desc">Unlock adult/explicit sound categories in the sound pickers. Confirms you are 18 or older.</div>
    </div>
    <div class="ctrl">
      <label class="tog">
        <input type="checkbox" id="adultConsented" onchange="send('toggleAdult',{value:this.checked})">
        <div class="track"><div class="thumb"></div></div>
      </label>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Error Sound</div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Sound</div>
      <div class="desc">Plays on non-zero exit codes</div>
    </div>
    <div class="ctrl sound-chip">
      <span class="sound-name" id="soundName">System Sound</span>
      <button class="sec" onclick="send('changeSound')">Change…</button>
    </div>
  </div>
  <div class="row">
    <div class="lbl-wrap"><div class="lbl">Volume</div></div>
    <div class="ctrl vol-wrap">
      <input type="range" min="0" max="100" id="volume" oninput="onVol(this.value)">
      <span class="vol-val" id="volVal">100%</span>
    </div>
  </div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Cooldown</div>
      <div class="desc">Minimum seconds between sounds (0 = no limit)</div>
    </div>
    <div class="ctrl">
      <input type="number" id="cooldown" min="0" max="60" onchange="send('setCooldown',{value:+this.value})">
    </div>
  </div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Ignored Exit Codes</div>
      <div class="desc">Comma-separated codes that never trigger a sound (e.g. 130, 1)</div>
    </div>
    <div class="ctrl">
      <input type="text" id="ignoredCodes" placeholder="130" onblur="onIgnored(this.value)">
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Success Sound</div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Sound</div>
      <div class="desc">Optional — plays when a command exits with code 0</div>
    </div>
    <div class="ctrl sound-chip">
      <span class="sound-name" id="successName">Disabled</span>
      <button class="sec" onclick="send('changeSuccessSound')">Change…</button>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Quiet Hours</div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Hours</div>
      <div class="desc">Silence all sounds during these times (24h format). Leave blank to disable. Supports overnight ranges (e.g. 22:00 to 08:00).</div>
    </div>
    <div class="ctrl quiet-pair">
      <input type="time" id="quietStart" onchange="onQuiet()">
      <span>to</span>
      <input type="time" id="quietEnd" onchange="onQuiet()">
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Diagnostics</div>
  <div class="row">
    <div class="lbl-wrap">
      <div class="lbl">Terminal Support</div>
      <div class="desc">Check which open terminals have shell integration active</div>
    </div>
    <div class="ctrl">
      <button class="sec" onclick="send('showTerminalSupport')">Show Status…</button>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
function send(type, extra) { vscode.postMessage({ type, ...extra }); }

let volT;
function onVol(v) {
  document.getElementById('volVal').textContent = v + '%';
  clearTimeout(volT);
  volT = setTimeout(() => send('setVolume', { value: +v }), 180);
}

function onIgnored(v) {
  const codes = v.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  send('setIgnoredCodes', { value: codes });
}

function onQuiet() {
  send('setQuietHours', {
    start: document.getElementById('quietStart').value,
    end: document.getElementById('quietEnd').value
  });
}

function soundLabel(id) {
  if (!id) return 'Disabled';
  if (id === 'SystemSound') return 'System Sound';
  if (id === 'Random') return 'Random';
  if (id === 'SelectiveRandom') return 'Selective Random';
  const parts = id.replace(/\\\\/g, '/').split('/');
  const f = parts[parts.length - 1];
  return f.replace(/\\.[^.]+$/, '');
}

let ready = false;
window.addEventListener('message', e => {
  const { type, config } = e.data;
  if (type !== 'update') return;
  document.getElementById('enabled').checked = config.enabled;
  document.getElementById('adultConsented').checked = config.adultConsented;
  document.getElementById('soundName').textContent = soundLabel(config.sound);
  document.getElementById('volume').value = config.volume;
  document.getElementById('volVal').textContent = config.volume + '%';
  document.getElementById('cooldown').value = config.cooldown;
  document.getElementById('ignoredCodes').value = config.ignoredExitCodes.join(', ');
  document.getElementById('successName').textContent = soundLabel(config.successSound);
  document.getElementById('quietStart').value = config.quietHoursStart;
  document.getElementById('quietEnd').value = config.quietHoursEnd;
  if (!ready) {
    ready = true;
    document.getElementById('enabled').addEventListener('change', () => send('toggle'));
  }
});
</script>
</body>
</html>`;
}

// ─── Deactivation ─────────────────────────────────────────────────────────────

export function deactivate() {
	statusBarItem?.dispose();
}
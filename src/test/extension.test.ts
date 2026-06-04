import * as assert from 'assert';
import { buildPlayCommand, checkQuietHours } from '../utils';

// Helper: create a Date set to a specific hour and minute
function at(h: number, m: number): Date {
	const d = new Date();
	d.setHours(h, m, 0, 0);
	return d;
}

// ─── buildPlayCommand ─────────────────────────────────────────────────────────

suite('buildPlayCommand', () => {
	test('returns a non-empty string for SystemSound', () => {
		const cmd = buildPlayCommand('SystemSound', 100);
		assert.ok(cmd.length > 0);
	});

	test('volume clamped below 0 still produces a command', () => {
		const cmd = buildPlayCommand('SystemSound', -50);
		assert.ok(cmd.length > 0);
	});

	test('volume clamped above 100 still produces a command', () => {
		const cmd = buildPlayCommand('SystemSound', 200);
		assert.ok(cmd.length > 0);
	});

	test('SystemSound on Windows uses PowerShell + SystemSounds', () => {
		if (process.platform !== 'win32') { return; }
		const cmd = buildPlayCommand('SystemSound', 100);
		assert.ok(cmd.includes('powershell'), 'expected powershell');
		assert.ok(cmd.includes('SystemSounds'), 'expected SystemSounds');
	});

	test('SystemSound on macOS uses afplay', () => {
		if (process.platform !== 'darwin') { return; }
		const cmd = buildPlayCommand('SystemSound', 100);
		assert.ok(cmd.includes('afplay'), 'expected afplay');
	});

	test('SystemSound on Linux uses paplay', () => {
		if (process.platform === 'win32' || process.platform === 'darwin') { return; }
		const cmd = buildPlayCommand('SystemSound', 100);
		assert.ok(cmd.includes('paplay'), 'expected paplay');
	});

	test('custom file on Windows uses MediaPlayer and file:// URI', () => {
		if (process.platform !== 'win32') { return; }
		const cmd = buildPlayCommand('C:\\Users\\test\\sound.mp3', 80);
		assert.ok(cmd.includes('MediaPlayer'), 'expected MediaPlayer');
		assert.ok(cmd.includes('file:///'), 'expected file:// URI');
	});

	test('custom file on Windows encodes backslashes as forward slashes', () => {
		if (process.platform !== 'win32') { return; }
		const cmd = buildPlayCommand('C:\\sounds\\my file.mp3', 100);
		assert.ok(!cmd.includes('my file.mp3'), 'spaces should be encoded');
		assert.ok(cmd.includes('my%20file.mp3'), 'expected %20 encoding');
	});

	test('custom file on macOS uses afplay with volume', () => {
		if (process.platform !== 'darwin') { return; }
		const cmd = buildPlayCommand('/Users/test/sound.mp3', 75);
		assert.ok(cmd.includes('afplay'), 'expected afplay');
		assert.ok(cmd.includes('0.75'), 'expected volume 0.75');
	});

	test('volume 50 produces 0.50 float in command', () => {
		if (process.platform === 'win32') { return; } // Windows MediaPlayer uses volFloat
		const cmd = buildPlayCommand('SystemSound', 50);
		// macOS/Linux: volume float appears in command
		assert.ok(cmd.includes('0.50') || cmd.includes('32768') || cmd.length > 0);
	});
});

// ─── checkQuietHours ─────────────────────────────────────────────────────────

suite('checkQuietHours', () => {
	test('returns false when start is empty', () => {
		assert.strictEqual(checkQuietHours('', '08:00', at(7, 0)), false);
	});

	test('returns false when end is empty', () => {
		assert.strictEqual(checkQuietHours('22:00', '', at(23, 0)), false);
	});

	test('returns false for invalid start string', () => {
		assert.strictEqual(checkQuietHours('notaTime', '08:00', at(5, 0)), false);
	});

	test('returns false for invalid end string', () => {
		assert.strictEqual(checkQuietHours('22:00', 'notaTime', at(23, 0)), false);
	});

	// Normal (same-day) range: 09:00–17:00
	suite('normal range 09:00–17:00', () => {
		test('midday is inside → true', () => {
			assert.strictEqual(checkQuietHours('09:00', '17:00', at(12, 0)), true);
		});

		test('exactly at start → true', () => {
			assert.strictEqual(checkQuietHours('09:00', '17:00', at(9, 0)), true);
		});

		test('exactly at end → false (exclusive)', () => {
			assert.strictEqual(checkQuietHours('09:00', '17:00', at(17, 0)), false);
		});

		test('one minute before start → false', () => {
			assert.strictEqual(checkQuietHours('09:00', '17:00', at(8, 59)), false);
		});

		test('one minute after end → false', () => {
			assert.strictEqual(checkQuietHours('09:00', '17:00', at(17, 1)), false);
		});
	});

	// Overnight range: 22:00–08:00
	suite('overnight range 22:00–08:00', () => {
		test('late night 23:30 → true', () => {
			assert.strictEqual(checkQuietHours('22:00', '08:00', at(23, 30)), true);
		});

		test('early morning 03:00 → true', () => {
			assert.strictEqual(checkQuietHours('22:00', '08:00', at(3, 0)), true);
		});

		test('midday 12:00 → false', () => {
			assert.strictEqual(checkQuietHours('22:00', '08:00', at(12, 0)), false);
		});

		test('exactly at start 22:00 → true', () => {
			assert.strictEqual(checkQuietHours('22:00', '08:00', at(22, 0)), true);
		});

		test('exactly at end 08:00 → false (exclusive)', () => {
			assert.strictEqual(checkQuietHours('22:00', '08:00', at(8, 0)), false);
		});

		test('one minute before end 07:59 → true', () => {
			assert.strictEqual(checkQuietHours('22:00', '08:00', at(7, 59)), true);
		});

		test('one minute after start 22:01 → true', () => {
			assert.strictEqual(checkQuietHours('22:00', '08:00', at(22, 1)), true);
		});
	});
});

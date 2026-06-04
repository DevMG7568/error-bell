// Pure utility functions — no VS Code API dependencies.
// Exported here so they can be unit-tested without the VS Code extension host.

export type BuiltInSound = 'SystemSound' | 'Random' | 'SelectiveRandom';
export type SoundOption = BuiltInSound | string;

/**
 * Returns true if `now` falls within the quiet-hours range [start, end).
 * Supports overnight ranges (e.g. 22:00–08:00).
 */
export function checkQuietHours(start: string, end: string, now: Date): boolean {
  if (!start || !end) { return false; }
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some(isNaN)) { return false; }
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins;
  }
  // Overnight range e.g. 22:00 → 08:00
  return nowMins >= startMins || nowMins < endMins;
}

/**
 * Builds the shell command used to play a sound file (or SystemSound).
 * Platform-aware: Windows (PowerShell/MediaPlayer), macOS (afplay), Linux (paplay/mpg123/ffplay).
 */
export function buildPlayCommand(soundId: SoundOption, volume = 100): string {
  const vol = Math.max(0, Math.min(100, volume));
  const volFloat = (vol / 100).toFixed(2);

  if (soundId === 'SystemSound') {
    if (process.platform === 'win32') { return 'powershell -c "[System.Media.SystemSounds]::Exclamation.Play()"'; }
    if (process.platform === 'darwin') { return `afplay -v ${volFloat} /System/Library/Sounds/Glass.aiff`; }
    return `paplay --volume=${Math.round(vol / 100 * 65536)} /usr/share/sounds/freedesktop/stereo/dialog-error.oga 2>/dev/null`;
  }

  if (process.platform === 'win32') {
    const uri = 'file:///' + soundId.replace(/\\/g, '/').replace(/ /g, '%20');
    return (
      `powershell -c "Add-Type -AssemblyName presentationCore; ` +
      `$mp = New-Object System.Windows.Media.MediaPlayer; ` +
      `$mp.Open([uri]'${uri}'); ` +
      `$mp.Volume = ${volFloat}; ` +
      `$mp.Play(); ` +
      `Start-Sleep -Milliseconds 5000; ` +
      `$mp.Stop(); $mp.Close()"`
    );
  }

  if (process.platform === 'darwin') {
    return `afplay -v ${volFloat} "${soundId}"`;
  }

  const paVol = Math.round(vol / 100 * 65536);
  return `paplay --volume=${paVol} "${soundId}" 2>/dev/null || mpg123 -q "${soundId}" 2>/dev/null || ffplay -nodisp -autoexit -loglevel quiet "${soundId}" 2>/dev/null`;
}

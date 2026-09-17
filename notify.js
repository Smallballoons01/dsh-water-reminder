/**
 * Desktop-notification adapters for @dsh-plugin/water-reminder.
 *
 * A reminder that only lives inside the chat is easy to miss while the user is
 * heads-down in another window, so the host half also raises a native OS
 * notification. Every adapter is a pure function from a payload to the exact
 * `argv` the subprocess capability should spawn, which keeps the platform
 * quirks testable without spawning anything.
 *
 * Windows is the awkward one: PowerShell's toast API needs WinRT types and a
 * large multi-line script, so the script is passed as `-EncodedCommand`
 * (UTF-16LE base64). That sidesteps both shell quoting and the fact that a
 * `.ps1` file with non-ASCII text is unreliable on Windows.
 *
 * @module water-reminder/notify
 */

/** Application name shown as the notification's source. */
export const NOTIFICATION_SOURCE = 'DeepSeek Harness'

/** Application name shown by Linux notifiers. */
export const LINUX_APP_NAME = 'deepseek-harness'

/**
 * Escape a string for use inside an AppleScript double-quoted literal.
 * @param text - the raw text.
 * @returns the escaped text, safe between ASCII double quotes.
 */
export function escapeAppleScriptString(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Escape a string for use as XML character data.
 * @param text - the raw text.
 * @returns the escaped text.
 */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * The AppleScript source for one notification.
 * @param payload - `{ title, message, sound }`.
 * @returns the script source.
 */
export function appleScriptNotification(payload) {
  const sound = payload.sound === false || payload.sound === undefined
    ? ''
    : ' sound name "Glass"'
  return `display notification "${escapeAppleScriptString(payload.message)}" `
    + `with title "${escapeAppleScriptString(payload.title)}"${sound}`
}

/**
 * The PowerShell source that shows a native Windows toast without any module
 * dependency, using the WinRT toast APIs directly.
 * @param payload - `{ title, message }`.
 * @returns the PowerShell script source.
 */
export function windowsToastScript(payload) {
  const title = escapeXml(payload.title)
  const message = escapeXml(payload.message)
  return [
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    `  $template = '<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${message}</text></binding></visual></toast>'`,
    '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $xml.LoadXml($template)',
    '  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${NOTIFICATION_SOURCE}').Show($toast)`,
    '} catch { exit 1 }',
  ].join('\n')
}

/**
 * Encode a PowerShell script for `-EncodedCommand`.
 * @param script - the script source.
 * @returns base64 of the UTF-16LE bytes, as PowerShell expects.
 */
export function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Build the notification command for a platform.
 *
 * The returned `argv` never relies on a shell: each platform's notifier is
 * invoked directly with fully-formed arguments.
 * @param platform - `process.platform` value, or the `platform` override.
 * @param payload - `{ title, message, sound, urgency }`; `sound` defaults to on
 *   and `urgency` is Linux-only (`low` | `normal` | `critical`).
 * @returns `{ argv, kind }`, or `undefined` when the platform has no adapter.
 */
export function buildNotificationCommand(platform, payload) {
  if (platform === 'darwin') {
    return { kind: 'osascript', argv: ['osascript', '-e', appleScriptNotification(payload)] }
  }
  if (platform === 'win32') {
    return {
      kind: 'powershell',
      argv: [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShellCommand(windowsToastScript(payload)),
      ],
    }
  }
  if (platform === 'linux') {
    return {
      kind: 'notify-send',
      argv: [
        'notify-send',
        '--app-name', LINUX_APP_NAME,
        '--urgency', payload.urgency ?? 'normal',
        payload.title,
        payload.message,
      ],
    }
  }
  return undefined
}

/**
 * The fallback ring/haptic cue used when an OS notification cannot be raised.
 * Keeping the sequence here (instead of inside the plugin) means the terminal
 * bell stays unit-testable and easy to silence.
 * @param platform - `process.platform` value.
 * @returns the bell text, or an empty string when the platform should stay silent.
 */
export function bellText(platform) {
  return platform === 'win32' ? '' : '\u0007'
}

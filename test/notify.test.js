/**
 * Unit tests for the desktop-notification adapters.
 *
 * These assert on the exact `argv` each platform produces, because a quoting
 * mistake here is invisible in review and only shows up as "the reminder never
 * arrived" on someone else's machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appleScriptNotification,
  bellText,
  buildNotificationCommand,
  encodePowerShellCommand,
  escapeAppleScriptString,
  escapeXml,
  windowsToastScript,
  LINUX_APP_NAME,
  NOTIFICATION_SOURCE,
} from '../notify.js'

test('escapeAppleScriptString neutralises quotes and backslashes', () => {
  assert.equal(escapeAppleScriptString('plain'), 'plain')
  assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"')
  assert.equal(escapeAppleScriptString('C:\\path'), 'C:\\\\path')
  assert.equal(escapeAppleScriptString('a "b" \\ c'), 'a \\"b\\" \\\\ c')
})

test('appleScriptNotification embeds the message, title, and optional sound', () => {
  const withSound = appleScriptNotification({ title: '喝水提醒', message: '该喝水了', sound: true })
  assert.equal(withSound, 'display notification "该喝水了" with title "喝水提醒" sound name "Glass"')
  assert.equal(
    appleScriptNotification({ title: 'T', message: 'M', sound: false }),
    'display notification "M" with title "T"',
  )
  // A message containing a double quote cannot terminate the literal early.
  const hostile = appleScriptNotification({ title: 'T', message: 'quote " end', sound: false })
  assert.equal(hostile, 'display notification "quote \\" end" with title "T"')
})

test('escapeXml covers the five predefined entities', () => {
  assert.equal(escapeXml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;')
  assert.equal(escapeXml('该喝水了'), '该喝水了')
})

test('windowsToastScript escapes interpolated text and uses the WinRT API', () => {
  const script = windowsToastScript({ title: 'T & <b>', message: 'M "q"' })
  assert.match(script, /\[Windows\.UI\.Notifications\.ToastNotificationManager/)
  assert.match(script, /T &amp; &lt;b&gt;/)
  assert.match(script, /M &quot;q&quot;/)
  assert.match(script, new RegExp(`CreateToastNotifier\\('${NOTIFICATION_SOURCE}'\\)`))
  // The whole thing is wrapped so a failure exits non-zero instead of printing a stack.
  assert.match(script, /catch \{ exit 1 \}/)
})

test('encodePowerShellCommand round-trips through UTF-16LE base64', () => {
  const script = windowsToastScript({ title: '喝水提醒', message: '该喝水了' })
  const encoded = encodePowerShellCommand(script)
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
})

test('darwin uses osascript with a single -e script argument', () => {
  const command = buildNotificationCommand('darwin', { title: 't', message: 'm', sound: true })
  assert.equal(command.kind, 'osascript')
  assert.equal(command.argv[0], 'osascript')
  assert.equal(command.argv[1], '-e')
  assert.equal(command.argv.length, 3)
  assert.equal(command.argv[2], 'display notification "m" with title "t" sound name "Glass"')
})

test('win32 passes the script as an encoded command, never as a file or inline text', () => {
  const command = buildNotificationCommand('win32', { title: 't', message: 'm' })
  assert.equal(command.kind, 'powershell')
  assert.deepEqual(command.argv.slice(0, 4), ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  assert.equal(command.argv.length, 5)
  assert.equal(
    Buffer.from(command.argv[4], 'base64').toString('utf16le'),
    windowsToastScript({ title: 't', message: 'm' }),
  )
})

test('linux uses notify-send with the app name and urgency', () => {
  const command = buildNotificationCommand('linux', { title: 't', message: 'm' })
  assert.equal(command.kind, 'notify-send')
  assert.deepEqual(command.argv, [
    'notify-send',
    '--app-name', LINUX_APP_NAME,
    '--urgency', 'normal',
    't',
    'm',
  ])
  assert.equal(buildNotificationCommand('linux', { title: 't', message: 'm', urgency: 'critical' }).argv[4], 'critical')
})

test('an unsupported platform degrades to no command instead of throwing', () => {
  assert.equal(buildNotificationCommand('aix', { title: 't', message: 'm' }), undefined)
  assert.equal(buildNotificationCommand('freebsd', { title: 't', message: 'm' }), undefined)
})

test('bellText is silent on Windows, where the console bell is a flash', () => {
  assert.equal(bellText('win32'), '')
  assert.equal(bellText('darwin'), '\u0007')
  assert.equal(bellText('linux'), '\u0007')
})

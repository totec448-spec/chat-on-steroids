# Microphone dictation (Windows)

The message composer offers optional speech-to-text on Windows. Click the
microphone button to begin listening, speak, and click again to finish. Recognition
results appear in the current message draft; the app **never sends the message
automatically**. You can review and edit the text before choosing Send.

Dictation uses Windows' own dictation engine (`Windows.Media.SpeechRecognition`, the
one behind Windows voice typing). It writes punctuation and follows the Windows speech
language. It needs a working microphone, Windows microphone access for desktop apps,
and **Online speech recognition** turned on in Windows' speech privacy settings.

When that engine cannot run, for example because Online speech recognition is off or
the Windows edition lacks it, the older offline recognizer (`System.Speech.Recognition`)
listens instead. It is less accurate and writes no punctuation, and the status line
under the composer says so and how to get the better engine. The offline recognizer
picks an installed speech language matching the Windows display language, then the same
language family, then the first one installed.

If the status line reports a microphone problem, check Windows' microphone privacy
setting for desktop apps and the selected recording device.

**Where audio goes.** Chat On Steroids never saves audio and never sends it anywhere
itself; it only receives recognized text and status through its own internal channel.
With Online speech recognition on, Windows sends your speech to Microsoft to recognize
it, as it does for Windows voice typing. The offline fallback keeps audio on the
computer. Text becomes part of a chat request only after you explicitly send the draft.

Typing in the draft, changing chats, leaving the composer or closing the app
retires its current dictation. Delayed recognition events cannot overwrite a
different draft. The button is hidden on macOS and Linux, where this native
Windows recognizer is unavailable.

Clicking Stop asks the recognizer to finish the phrase in progress and report it;
it then closes by itself, and is ended after four seconds if it does not. Quitting the
app instead kills its PowerShell child immediately. The child also checks the original app process ID once per second
and exits if the app crashes or is forcibly terminated, releasing the audio
device without relying on a graceful shutdown.

To exercise the protocol, run:

```sh
npx vitest run test/dictation.test.ts test/dictation-lifecycle.test.ts test/renderer-dictation.test.ts
```

On a Windows machine with a prepared speech WAV, the optional
`node scripts/smoke-dictation-windows.cjs <path-to-wav>` checks the offline
recognizer's events against synthetic audio without using the microphone.
It is an explicit smoke test; it does not run as part of CI.

On Windows, `node scripts/fixtures/smoke-dictation-parent-windows.cjs` parses the whole
recognizer script with PowerShell, compiles its C# engine, and runs the actual loop twice:
once ending because a synthetic parent process disappears, once on Stop.
The recognizer setup is replaced with a no-microphone fixture, so
this check never opens the audio device. The same smoke check runs under
`test/dictation-lifecycle.test.ts` on Windows.

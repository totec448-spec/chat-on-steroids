# Microphone dictation (Windows)

The message composer offers optional local speech-to-text on Windows. Click the
microphone button to begin listening, speak, and click again to finish. Recognition
results appear in the current message draft; the app **never sends the message
automatically**. You can review and edit the text before choosing Send.

The recognizer runs through Windows PowerShell and the built-in
`System.Speech.Recognition` API. It requires a working microphone, Windows
microphone access for desktop apps, and an installed Windows speech recognizer.
The app selects a recognizer that matches the current Windows UI language when
one is available, then the same language family, then the first installed
recognizer. Recognition quality and supported languages depend on Windows.
If you see a recognizer or microphone error, check **Windows Settings > Privacy &
security > Microphone**, your speech language installation, and the selected
recording device.

Audio stays with the local Windows speech-recognition engine. Chat On Steroids
only receives the resulting text and recognition status through its own internal
IPC channel; it does not save audio or send audio to ChatGPT. Text becomes part
of a normal chat request only after you explicitly send the draft.

Typing in the draft, changing chats, leaving the composer or closing the app
retires its current dictation. Delayed recognition events cannot overwrite a
different draft. The button is hidden on macOS and Linux, where this native
Windows recognizer is unavailable.

Clicking Stop briefly allows pending recognized words to be delivered before
the recognizer closes. Quitting the app instead kills its PowerShell child
immediately. The child also checks the original app process ID once per second
and exits if the app crashes or is forcibly terminated, releasing the audio
device without relying on a graceful shutdown.

To exercise the protocol, run:

```sh
npx vitest run test/dictation.test.ts test/dictation-lifecycle.test.ts test/renderer-dictation.test.ts
```

On a Windows machine with a prepared speech WAV, the optional
`node scripts/smoke-dictation-windows.cjs <path-to-wav>` checks the native
recognition events against synthetic audio without using the microphone.
It is an explicit smoke test; it does not run as part of CI.

On Windows, `node scripts/fixtures/smoke-dictation-parent-windows.cjs` checks the
actual PowerShell parent-liveness loop by killing a synthetic parent process.
The recognizer setup is replaced with a no-microphone fixture, so
this check never opens the audio device. The same smoke check runs under
`test/dictation-lifecycle.test.ts` on Windows.

// Target the fixture renderer through Chromium, not the OS-focused window.
// Unlike a DOM KeyboardEvent, this exercises the HTML dialog's default Escape behavior.
function keyboardFor(webContents) {
  const session = webContents.debugger;
  session.attach('1.3');
  return async (key, windowsVirtualKeyCode) => {
    const event = { key, code: key, windowsVirtualKeyCode };
    await session.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
    await session.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  };
}

module.exports = { keyboardFor };

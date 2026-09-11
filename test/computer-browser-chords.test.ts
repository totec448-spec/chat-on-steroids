import { describe, expect, it } from 'vitest';
import { browserTabChord, isBrowserProcess } from '../src/main/computer/browser-chords.js';

describe('browser tab and window chords', () => {
  it('names the chords a browser takes for tab and window management', () => {
    expect(browserTabChord(['ctrl', 'w'])).toBe('ctrl+w');
    expect(browserTabChord(['Ctrl', 'Shift', 'Tab'])).toBe('ctrl+shift+tab');
    expect(browserTabChord(['shift', 'control', 'w'])).toBe('ctrl+shift+w');
    expect(browserTabChord(['ctrl', 'PageUp'])).toBe('ctrl+pageup');
    expect(browserTabChord(['ctrl', 'pgdn'])).toBe('ctrl+pagedown');
    expect(browserTabChord(['alt', 'ArrowLeft'])).toBe('alt+left');
    expect(browserTabChord(['alt', 'f4'])).toBe('alt+f4');
    expect(browserTabChord(['ctrl', '4'])).toBe('ctrl+4');
    expect(browserTabChord(['Control_L', 'w'])).toBe('ctrl+w');
    expect(browserTabChord([' Control_R ', 'Shift_R', 'Tab'])).toBe('ctrl+shift+tab');
    expect(browserTabChord(['Ctrl_R', 'Prior'])).toBe('ctrl+pageup');
    expect(browserTabChord(['Ctrl_L', 'Next'])).toBe('ctrl+pagedown');
    expect(browserTabChord(['Alt_L', 'Left'])).toBe('alt+left');
    // macOS spellings, refused on every host: the model names the keys, not the OS.
    expect(browserTabChord(['cmd', 'w'])).toBe('cmd+w');
    expect(browserTabChord(['command', 'shift', 't'])).toBe('cmd+shift+t');
    expect(browserTabChord(['meta', 'q'])).toBe('cmd+q');
    expect(browserTabChord(['cmd', 'option', 'ArrowLeft'])).toBe('cmd+alt+left');
    expect(browserTabChord(['cmd', 'shift', ']'])).toBe('cmd+shift+]');
    expect(browserTabChord(['cmd', '3'])).toBe('cmd+3');
  });

  it('leaves every other key to the page', () => {
    // Address entry is the same authorized navigation as clicking the omnibox or set_value.
    expect(browserTabChord(['Control_L', 'l'])).toBeNull();
    expect(browserTabChord(['alt', 'd'])).toBeNull();
    expect(browserTabChord(['cmd', 'l'])).toBeNull();
    expect(browserTabChord(['cmd', 'alt', 'f'])).toBeNull();
    expect(browserTabChord(['ctrl', 'r'])).toBeNull();
    expect(browserTabChord(['ctrl', 'v'])).toBeNull();
    expect(browserTabChord(['cmd', 'v'])).toBeNull();
    expect(browserTabChord(['cmd', 's'])).toBeNull();
    expect(browserTabChord(['cmd', 'shift', 'z'])).toBeNull();
    expect(browserTabChord(['enter'])).toBeNull();
    expect(browserTabChord(['w'])).toBeNull();
    expect(browserTabChord(['tab'])).toBeNull();
    expect(browserTabChord(['ctrl', 'alt', 'w'])).toBeNull();
    expect(browserTabChord(['ctrl'])).toBeNull();
    expect(browserTabChord([])).toBeNull();
  });

  it('knows a browser by its process name', () => {
    expect(isBrowserProcess('chrome')).toBe(true);
    expect(isBrowserProcess('Chrome.exe')).toBe(true);
    expect(isBrowserProcess('msedge')).toBe(true);
    expect(isBrowserProcess('firefox')).toBe(true);
    // macOS reports the owning application name, not an image name.
    expect(isBrowserProcess('Google Chrome')).toBe(true);
    expect(isBrowserProcess('Google Chrome Canary')).toBe(true);
    expect(isBrowserProcess('Brave Browser')).toBe(true);
    expect(isBrowserProcess('Microsoft Edge')).toBe(true);
    expect(isBrowserProcess('Safari')).toBe(true);
    expect(isBrowserProcess('Arc')).toBe(true);
    expect(isBrowserProcess('Archive Utility')).toBe(false);
    expect(isBrowserProcess('Finder')).toBe(false);
    expect(isBrowserProcess('Terminal')).toBe(false);
    expect(isBrowserProcess('notepad')).toBe(false);
    expect(isBrowserProcess('Code')).toBe(false);
    expect(isBrowserProcess('')).toBe(false);
  });
});

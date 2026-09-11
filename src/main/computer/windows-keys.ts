/** One native key authority. Punctuation is resolved in the target thread's layout. */
export const WINDOWS_KEYS_SOURCE = String.raw`
public static class CosWindowsKeys {
  const int Extended = 0x10000;
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern short VkKeyScanExW(char character, IntPtr layout);

  static readonly System.Collections.Generic.Dictionary<string, int> Named = new System.Collections.Generic.Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) {
    {"CTRL",0x11},{"CONTROL",0x11},{"SHIFT",0x10},{"ALT",0x12},{"OPTION",0x12},
    {"CONTROL_L",0xA2},{"CTRL_L",0xA2},{"CONTROL_R",Extended|0xA3},{"CTRL_R",Extended|0xA3},
    {"SHIFT_L",0xA0},{"SHIFT_R",0xA1},{"ALT_L",0xA4},{"ALT_R",Extended|0xA5},
    {"WIN",Extended|0x5B},{"WINDOWS",Extended|0x5B},{"SUPER",Extended|0x5B},{"META",Extended|0x5B},{"CMD",Extended|0x5B},{"COMMAND",Extended|0x5B},
    {"SUPER_L",Extended|0x5B},{"META_L",Extended|0x5B},{"SUPER_R",Extended|0x5C},{"META_R",Extended|0x5C},
    {"ENTER",0x0D},{"RETURN",0x0D},{"TAB",0x09},{"ESC",0x1B},{"ESCAPE",0x1B},{"SPACE",0x20},
    {"BACKSPACE",0x08},{"BACK_SPACE",0x08},{"BKSP",0x08},{"DELETE",Extended|0x2E},{"DEL",Extended|0x2E},{"INSERT",Extended|0x2D},{"INS",Extended|0x2D},
    {"HOME",Extended|0x24},{"END",Extended|0x23},{"PAGEUP",Extended|0x21},{"PAGE_UP",Extended|0x21},{"PGUP",Extended|0x21},{"PRIOR",Extended|0x21},
    {"PAGEDOWN",Extended|0x22},{"PAGE_DOWN",Extended|0x22},{"PGDN",Extended|0x22},{"NEXT",Extended|0x22},
    {"UP",Extended|0x26},{"ARROWUP",Extended|0x26},{"DOWN",Extended|0x28},{"ARROWDOWN",Extended|0x28},
    {"LEFT",Extended|0x25},{"ARROWLEFT",Extended|0x25},{"RIGHT",Extended|0x27},{"ARROWRIGHT",Extended|0x27},
    {"PRINTSCREEN",Extended|0x2C},{"PRINT",Extended|0x2C},{"CAPSLOCK",0x14},{"CAPS_LOCK",0x14},
    {"NUMLOCK",Extended|0x90},{"NUM_LOCK",Extended|0x90},{"SCROLLLOCK",0x91},{"SCROLL_LOCK",0x91},{"PAUSE",0x13},
    {"MENU",Extended|0x5D},{"APPS",Extended|0x5D},
    {"KP_ENTER",Extended|0x0D},{"KP_ADD",0x6B},{"KP_SUBTRACT",0x6D},{"KP_MULTIPLY",0x6A},{"KP_DIVIDE",Extended|0x6F},{"KP_DECIMAL",0x6E},
    {"KP_SEPARATOR",0x6C},{"KP_HOME",0x24},{"KP_END",0x23},{"KP_UP",0x26},{"KP_DOWN",0x28},{"KP_LEFT",0x25},{"KP_RIGHT",0x27},
    {"KP_PRIOR",0x21},{"KP_NEXT",0x22},{"KP_INSERT",0x2D},{"KP_DELETE",0x2E}
  };
  static readonly System.Collections.Generic.Dictionary<string, char> Symbols = new System.Collections.Generic.Dictionary<string, char>(StringComparer.OrdinalIgnoreCase) {
    {"MINUS",'-'},{"EQUALS",'='},{"EQUAL",'='},{"PLUS",'+'},{"LBRACKET",'['},{"BRACKETLEFT",'['},{"RBRACKET",']'},{"BRACKETRIGHT",']'},
    {"BACKSLASH",'\\'},{"SEMICOLON",';'},{"COLON",':'},{"QUOTE",'\''},{"APOSTROPHE",'\''},{"QUOTEDBL",'"'},
    {"COMMA",','},{"PERIOD",'.'},{"SLASH",'/'},{"QUESTION",'?'},{"GREATER",'>'},{"LESS",'<'},
    {"BACKQUOTE",(char)96},{"GRAVE",(char)96},{"TILDE",'~'},{"ASCIITILDE",'~'},{"EXCLAM",'!'},{"AT",'@'},
    {"NUMBERSIGN",'#'},{"DOLLAR",'$'},{"PERCENT",'%'},{"ASCIICIRCUM",'^'},{"AMPERSAND",'&'},{"ASTERISK",'*'},
    {"PARENLEFT",'('},{"PARENRIGHT",')'},{"UNDERSCORE",'_'},{"BRACELEFT",'{'},{"BRACERIGHT",'}'},{"BAR",'|'}
  };

  public static int[] Resolve(string[] names, long targetWindow) {
    IntPtr window = targetWindow == 0 ? GetForegroundWindow() : new IntPtr(targetWindow);
    uint process;
    uint thread = GetWindowThreadProcessId(window, out process);
    if (thread == 0) throw new InvalidOperationException("BAD_KEY: target window has no keyboard layout");
    IntPtr layout = GetKeyboardLayout(thread);
    if (layout == IntPtr.Zero) throw new InvalidOperationException("BAD_KEY: target keyboard layout is unavailable");
    return ResolveForLayout(names, layout, VkKeyScanExW);
  }

  static int ModifierGroup(int key) {
    int vk = key & 0xFFFF;
    if (vk == 0x10 || vk == 0xA0 || vk == 0xA1) return 1;
    if (vk == 0x11 || vk == 0xA2 || vk == 0xA3) return 2;
    if (vk == 0x12 || vk == 0xA4 || vk == 0xA5) return 4;
    if (vk == 0x5B || vk == 0x5C) return 8;
    return 0;
  }

  // Injectable layout translation lets tests cover US/German/AltGr mappings without
  // installing or activating a keyboard layout on the user's desktop.
  public static int[] ResolveForLayout(string[] names, IntPtr layout, Func<char, IntPtr, short> translate) {
    if (names == null || names.Length == 0 || names.Length > 16) throw new ArgumentException("BAD_KEY: a chord needs between 1 and 16 keys");
    var modifiers = new System.Collections.Generic.List<int>();
    var keys = new System.Collections.Generic.List<int>();
    int required = 0;
    foreach (string raw in names) {
      string name = (raw ?? "").Trim();
      if (name.Length == 0) throw new ArgumentException("BAD_KEY: key name is empty");
      if (name.StartsWith("NUMPAD_", StringComparison.OrdinalIgnoreCase)) name = "KP_" + name.Substring(7);
      int key, number;
      if (!Named.TryGetValue(name, out key)) {
        if (name.Length >= 2 && name.Length <= 3 && (name[0] == 'F' || name[0] == 'f') && int.TryParse(name.Substring(1), out number) && number >= 1 && number <= 24) key = 0x6F + number;
        else if (name.Length == 4 && name.StartsWith("KP_", StringComparison.OrdinalIgnoreCase) && name[3] >= '0' && name[3] <= '9') key = 0x60 + name[3] - '0';
        else if (name.Length == 1 && ((name[0] >= 'a' && name[0] <= 'z') || (name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= '0' && name[0] <= '9'))) key = char.ToUpperInvariant(name[0]);
        else {
          char symbol;
          if (!Symbols.TryGetValue(name, out symbol)) {
            if (name.Length != 1 || char.IsControl(name[0]) || char.IsSurrogate(name[0])) throw new ArgumentException("BAD_KEY: unsupported key " + name);
            symbol = name[0];
          }
          short mapped = translate(symbol, layout);
          if (mapped == -1 || ((mapped >> 8) & 0xFF) > 7) throw new ArgumentException("BAD_KEY: key is unavailable in the target keyboard layout: " + name);
          key = mapped & 0xFF;
          required |= (mapped >> 8) & 7;
        }
      }
      if (ModifierGroup(key) != 0) { if (!modifiers.Contains(key)) modifiers.Add(key); }
      else { if (keys.Contains(key)) throw new ArgumentException("BAD_KEY: chord repeats a key"); keys.Add(key); }
    }
    int present = 0;
    foreach (int modifier in modifiers) present |= ModifierGroup(modifier);
    if ((required & 1) != 0 && (present & 1) == 0) modifiers.Add(0x10);
    if ((required & 2) != 0 && (present & 2) == 0) modifiers.Add(0x11);
    if ((required & 4) != 0 && (present & 4) == 0) modifiers.Add(0x12);
    modifiers.AddRange(keys);
    return modifiers.ToArray();
  }
}
`;

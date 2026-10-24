#[cfg(not(windows))]
fn main() {
    eprintln!("cos-windows-pet-focus is available only on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod win32 {
    use cos_windows_pet_focus::{parse_handle, Command, FocusState, Identity, NativeFocus};
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
        io::{self, BufRead, BufReader, Write},
        sync::mpsc::{self, Receiver, SyncSender},
        thread,
    };
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        System::{SystemInformation::GetTickCount, Threading::GetCurrentThreadId},
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            Input::KeyboardAndMouse::IsWindowEnabled,
            WindowsAndMessaging::{
                DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
                IsIconic, IsWindowVisible, PeekMessageW, PostThreadMessageW, SetForegroundWindow,
                TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, PM_NOREMOVE, WINEVENT_OUTOFCONTEXT,
                WM_APP,
            },
        },
    };

    const COMMAND_MESSAGE: u32 = WM_APP + 31;
    const MAX_LINE_BYTES: usize = 1024;
    const MAX_PENDING_EVENTS: usize = 256;

    thread_local! {
        static FOCUS: RefCell<Option<FocusState<WindowsNative>>> = const { RefCell::new(None) };
        static EVENTS: RefCell<VecDeque<(u64, u32)>> = const { RefCell::new(VecDeque::new()) };
        static LOST_EVENTS: Cell<bool> = const { Cell::new(false) };
    }

    struct WindowsNative;

    fn hwnd(value: u64) -> Option<HWND> {
        let address = usize::try_from(value).ok()?;
        (address != 0).then_some(HWND(address as *mut _))
    }

    impl NativeFocus for WindowsNative {
        fn foreground(&self) -> u64 {
            // SAFETY: GetForegroundWindow has no inputs; NULL is represented as 0.
            unsafe { GetForegroundWindow().0 as usize as u64 }
        }

        fn event_clock(&self) -> u32 {
            // SAFETY: GetTickCount reads the same monotonic counter used for WinEvent timestamps.
            unsafe { GetTickCount() }
        }

        fn identity(&self, handle: u64) -> Option<Identity> {
            let handle = hwnd(handle)?;
            // SAFETY: Windows validates HWNDs and writes the process ID to a live local u32.
            unsafe {
                let mut process = 0;
                let thread = GetWindowThreadProcessId(handle, Some(&mut process));
                (thread != 0 && process != 0).then_some(Identity { process, thread })
            }
        }

        fn eligible_identity(&self, handle: u64) -> Option<Identity> {
            let handle = hwnd(handle)?;
            // SAFETY: three Win32 calls are read-only on the candidate HWND. A hidden,
            // disabled or minimized return target is never eligible for focus transfer.
            unsafe {
                if !IsWindowVisible(handle).as_bool()
                    || !IsWindowEnabled(handle).as_bool()
                    || IsIconic(handle).as_bool()
                {
                    return None;
                }
            }
            self.identity(handle.0 as usize as u64)
        }

        fn activate_once(&self, handle: u64) {
            if let Some(handle) = hwnd(handle) {
                // SAFETY: HWND identity/eligibility and foreground were rechecked immediately
                // before this single OS-governed attempt. No retry or thread attachment.
                unsafe {
                    let _ = SetForegroundWindow(handle);
                }
            }
        }
    }

    /// Windows can reenter a WinEvent callback. Queue the observed events before draining
    /// them on this same thread so an inner notification never overtakes its outer owner.
    unsafe extern "system" fn on_win_event(
        _hook: HWINEVENTHOOK,
        event: u32,
        handle: HWND,
        _object: i32,
        _child: i32,
        _thread: u32,
        time: u32,
    ) {
        if event != EVENT_SYSTEM_FOREGROUND {
            return;
        }
        EVENTS.with(|events| {
            let mut events = events.borrow_mut();
            if events.len() == MAX_PENDING_EVENTS {
                events.clear();
                LOST_EVENTS.with(|lost| lost.set(true));
            } else {
                events.push_back((handle.0 as usize as u64, time));
            }
        });
        drain_events();
    }

    fn drain_events() {
        FOCUS.with(|focus| {
            let Ok(mut focus) = focus.try_borrow_mut() else {
                return;
            };
            let Some(focus) = focus.as_mut() else {
                return;
            };
            if LOST_EVENTS.with(|lost| lost.replace(false)) {
                EVENTS.with(|events| events.borrow_mut().clear());
                focus.lose_observations();
                return;
            }
            loop {
                let next = EVENTS.with(|events| events.borrow_mut().pop_front());
                let Some((handle, time)) = next else {
                    break;
                };
                focus.on_foreground(handle, time);
                if LOST_EVENTS.with(|lost| lost.replace(false)) {
                    EVENTS.with(|events| events.borrow_mut().clear());
                    focus.lose_observations();
                    break;
                }
            }
        });
    }

    /// Read one UTF-8 JSON line without allocating an arbitrarily large input buffer.
    fn read_line<R: BufRead>(source: &mut R) -> io::Result<Option<String>> {
        let mut bytes = Vec::new();
        loop {
            let available = source.fill_buf()?;
            if available.is_empty() {
                return if bytes.is_empty() {
                    Ok(None)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "unterminated command",
                    ))
                };
            }
            let count = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if bytes.len() + count > MAX_LINE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "command exceeds 1024 bytes",
                ));
            }
            bytes.extend_from_slice(&available[..count]);
            source.consume(count);
            if bytes.last() == Some(&b'\n') {
                let line = String::from_utf8(bytes).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8 command")
                })?;
                return Ok(Some(line));
            }
        }
    }

    fn read_commands(tx: SyncSender<Command>, message_thread: u32) {
        let mut source = BufReader::new(io::stdin().lock());
        loop {
            let command = match read_line(&mut source) {
                Ok(Some(line)) => match serde_json::from_str::<Command>(&line) {
                    Ok(command) => command,
                    Err(_) => {
                        eprintln!("invalid pet focus command");
                        Command::Dispose
                    }
                },
                Ok(None) => Command::Dispose,
                Err(error) => {
                    eprintln!("pet focus stdin: {error}");
                    Command::Dispose
                }
            };
            let finished = command == Command::Dispose;
            if tx.send(command).is_err() {
                break;
            }
            // SAFETY: message_thread is the live WinEvent/message-loop thread; a failed post
            // is harmless during startup, whose first command is consumed synchronously.
            unsafe {
                let _ = PostThreadMessageW(message_thread, COMMAND_MESSAGE, WPARAM(0), LPARAM(0));
            }
            if finished {
                break;
            }
        }
    }

    fn handle_commands(rx: &Receiver<Command>) -> bool {
        while let Ok(command) = rx.try_recv() {
            let finished = command == Command::Dispose;
            FOCUS.with(|focus| {
                if let Some(focus) = focus.borrow_mut().as_mut() {
                    match command {
                        Command::Revoke => focus.revoke(),
                        Command::Release => focus.release(),
                        Command::Dispose => focus.dispose(),
                        Command::Start { .. } => focus.dispose(), // No restart, no HWND replacement.
                    }
                }
            });
            drain_events();
            if finished || matches!(command, Command::Start { .. }) {
                return true;
            }
        }
        false
    }

    pub fn run() -> Result<(), String> {
        // SAFETY: creates a Win32 thread message queue before the stdin thread posts to it.
        let thread_id = unsafe { GetCurrentThreadId() };
        let mut message = MSG::default();
        unsafe {
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        }

        let (tx, rx) = mpsc::sync_channel(64);
        thread::spawn(move || read_commands(tx, thread_id));
        let start = rx.recv().map_err(|_| "missing start command".to_string())?;
        let Command::Start { hwnd: requested } = start else {
            return Err("first command must be start".into());
        };
        let own_handle = parse_handle(&requested).ok_or_else(|| "invalid HWND".to_string())?;
        let state = FocusState::start(WindowsNative, own_handle)
            .ok_or_else(|| "pet overlay HWND is unavailable".to_string())?;
        FOCUS.with(|focus| *focus.borrow_mut() = Some(state));

        // SAFETY: callback has the correct ABI, no module handle because OUTOFCONTEXT is set;
        // this thread runs GetMessage until shutdown and owns UnhookWinEvent before exiting.
        let hook = unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_win_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.is_invalid() {
            FOCUS.with(|focus| focus.borrow_mut().take());
            return Err("failed to install foreground event hook".into());
        }
        FOCUS.with(|focus| {
            if let Some(focus) = focus.borrow_mut().as_mut() {
                focus.hook_installed();
            }
        });

        let ready = io::stdout()
            .write_all(b"{\"event\":\"ready\"}\n")
            .and_then(|_| io::stdout().flush());
        let mut finished = ready.is_err() || handle_commands(&rx);
        while !finished {
            // SAFETY: Win32 fills MSG; dispatch pumps the out-of-context WinEvent callback
            // on this same thread. WM_APP is consumed here rather than sent to a window.
            let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
            if result.0 <= 0 {
                break;
            }
            if message.message != COMMAND_MESSAGE {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            drain_events();
            finished = handle_commands(&rx);
        }

        // SAFETY: the hook is uninstalled on its registering thread, before clearing the
        // actor's state or permitting this process to exit. No replacement hook is installed.
        unsafe {
            let _ = UnhookWinEvent(hook);
        }
        FOCUS.with(|focus| focus.borrow_mut().take());
        EVENTS.with(|events| events.borrow_mut().clear());
        if let Err(error) = ready {
            return Err(format!("pet focus ready stream: {error}"));
        }
        Ok(())
    }

    #[cfg(test)]
    mod parser_tests {
        use super::*;
        use std::io::{Cursor, ErrorKind};

        #[test]
        fn reads_consecutive_frames_without_consuming_the_next_command() {
            let mut input =
                Cursor::new(b"{\"op\":\"start\",\"hwnd\":\"42\"}\r\n{\"op\":\"release\"}\n");
            assert_eq!(
                serde_json::from_str::<Command>(&read_line(&mut input).unwrap().unwrap()).unwrap(),
                Command::Start { hwnd: "42".into() }
            );
            assert_eq!(
                serde_json::from_str::<Command>(&read_line(&mut input).unwrap().unwrap()).unwrap(),
                Command::Release
            );
            assert!(read_line(&mut input).unwrap().is_none());
        }

        #[test]
        fn maximum_size_includes_delimiter_and_accepts_exactly_the_bound() {
            let mut exact = vec![b'x'; MAX_LINE_BYTES - 1];
            exact.push(b'\n');
            let mut input = Cursor::new(exact);
            assert_eq!(
                read_line(&mut input).unwrap().unwrap().len(),
                MAX_LINE_BYTES
            );
            let mut oversized = Cursor::new(vec![b'x'; MAX_LINE_BYTES + 1]);
            assert_eq!(
                read_line(&mut oversized).unwrap_err().kind(),
                ErrorKind::InvalidData
            );
        }

        #[test]
        fn incomplete_frame_is_error_but_clean_eof_is_not() {
            let mut incomplete = Cursor::new(b"{\"op\":\"release\"}".as_slice());
            assert_eq!(
                read_line(&mut incomplete).unwrap_err().kind(),
                ErrorKind::UnexpectedEof
            );
            let mut empty = Cursor::new(Vec::<u8>::new());
            assert!(read_line(&mut empty).unwrap().is_none());
        }

        #[test]
        fn refuses_invalid_utf8_without_replacement_or_reinterpretation() {
            let mut input = Cursor::new([0xff, b'\n']);
            assert_eq!(
                read_line(&mut input).unwrap_err().kind(),
                ErrorKind::InvalidData
            );
        }
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = win32::run() {
        eprintln!("cos-windows-pet-focus: {error}");
        std::process::exit(1);
    }
}

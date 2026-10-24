//! One running app per user-data folder. Electron's `requestSingleInstanceLock` and its
//! `second-instance` event.
//!
//! The first process takes an OS file lock on `<userData>/instance.lock` and listens on a
//! loopback port that it publishes, with a random token, in `<userData>/instance.json`. A later
//! process on the same folder fails to take the lock, sends its command line to that port and
//! exits. The OS releases the lock when its owner exits, so a crashed owner leaves nothing the
//! next launch has to clean up: it takes the lock and rewrites the endpoint.
//!
//! On Windows the lock file is open without delete sharing, so while the owner runs nobody can
//! delete or rename the lock file or the folder, and a later launch never finds the folder free.
//! A later launch that cannot take the lock and cannot use `instance.json` (deleted, or naming a
//! dead port) fails with an error. It never takes the folder.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::hash::{BuildHasher, RandomState};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const LOCK_FILE: &str = "instance.lock";
const ENDPOINT_FILE: &str = "instance.json";
/// How long a second launch waits for a first one that holds the lock but has not published
/// its endpoint yet.
const ENDPOINT_WAIT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: u64 = 64 * 1024;

/// The outcome of [`Instance::acquire`].
pub enum Acquired {
    /// This process owns the folder. Later launches arrive on [`Instance::second_launches`].
    Primary(Instance),
    /// Another process owns the folder and received this command line. Exit now.
    Forwarded,
}

/// The lock owner. Dropping it releases the folder.
pub struct Instance {
    _lock: File,
    launches: Receiver<Vec<String>>,
    stop: Arc<AtomicBool>,
    address: SocketAddr,
}

#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

#[derive(Serialize, Deserialize)]
struct Launch {
    token: String,
    argv: Vec<String>,
}

impl Instance {
    /// Takes the folder or forwards `argv` to the process that has it.
    pub fn acquire(user_data: &Path, argv: &[String]) -> io::Result<Acquired> {
        fs::create_dir_all(user_data)?;
        let lock = open_lock(&user_data.join(LOCK_FILE))?;
        match lock.try_lock() {
            Ok(()) => Self::serve(user_data, lock).map(Acquired::Primary),
            Err(TryLockError::WouldBlock) => forward(user_data, argv).map(|()| Acquired::Forwarded),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }

    /// Command lines of later launches on this folder, in arrival order.
    pub fn second_launches(&self) -> &Receiver<Vec<String>> {
        &self.launches
    }

    fn serve(user_data: &Path, lock: File) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let address = listener.local_addr()?;
        let token = token();
        let endpoint = serde_json::to_vec(&Endpoint {
            port: address.port(),
            token: token.clone(),
        })?;
        let file = user_data.join(ENDPOINT_FILE);
        crate::durable::write_replacing(
            &file,
            &user_data.join(format!("{ENDPOINT_FILE}.tmp")),
            &endpoint,
        )?;
        let (sender, launches) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        thread::Builder::new()
            .name("second-instance".into())
            .spawn(move || accept(&listener, &token, &sender, &stopping))?;
        Ok(Self {
            _lock: lock,
            launches,
            stop,
            address,
        })
    }
}

/// std shares files for deletion on Windows, which would let another process delete the held
/// lock file, or the whole folder, and then create a fresh unlocked one.
fn open_lock(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    options.open(path)
}

impl Drop for Instance {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it sees the stop flag.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
    }
}

fn accept(listener: &TcpListener, token: &str, sender: &Sender<Vec<String>>, stop: &AtomicBool) {
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok(stream) = stream else { continue };
        // A caller without the token is dropped; one that stalls holds the loop for at most
        // IO_TIMEOUT.
        if let Some(argv) = receive(stream, token)
            && sender.send(argv).is_err()
        {
            return;
        }
    }
}

fn receive(stream: TcpStream, token: &str) -> Option<Vec<String>> {
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_MESSAGE_BYTES))
        .read_line(&mut line)
        .ok()?;
    let launch: Launch = serde_json::from_str(&line).ok()?;
    if launch.token != token {
        return None;
    }
    (&stream).write_all(b"ok\n").ok()?;
    Some(launch.argv)
}

/// Retries until the owner has published a live endpoint: the owner takes the lock before it
/// writes `instance.json`, and a file left by a crashed owner names a dead port.
fn forward(user_data: &Path, argv: &[String]) -> io::Result<()> {
    let file = user_data.join(ENDPOINT_FILE);
    let deadline = Instant::now() + ENDPOINT_WAIT;
    loop {
        match send(&file, argv) {
            Ok(()) => return Ok(()),
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "another process holds this folder, but {} does not reach it: {error}",
                        file.display()
                    ),
                ));
            }
        }
    }
}

fn send(file: &Path, argv: &[String]) -> io::Result<()> {
    let endpoint: Endpoint = serde_json::from_slice(&fs::read(file)?)?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = TcpStream::connect_timeout(&address, IO_TIMEOUT)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    let mut message = serde_json::to_vec(&Launch {
        token: endpoint.token,
        argv: argv.to_vec(),
    })?;
    message.push(b'\n');
    stream.write_all(&message)?;
    let mut reply = String::new();
    BufReader::new(&stream).read_line(&mut reply)?;
    if reply.trim_end() == "ok" {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "the running instance did not accept the launch",
        ))
    }
}

fn token() -> String {
    let state = RandomState::new();
    format!(
        "{:016x}{:016x}",
        state.hash_one(Instant::now()),
        RandomState::new().hash_one(std::process::id())
    )
}

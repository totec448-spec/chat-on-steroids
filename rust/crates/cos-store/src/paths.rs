//! Where the app keeps its data, and the two launch switches that change how it starts.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

/// The folder name Electron derived from `package.json`, kept so both builds share one profile.
pub const APP_DIR_NAME: &str = "chat-on-steroids";

/// The launch switches the app reads from its command line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchArgs {
    /// `--user-data-dir=<path>`: run on another profile, as Chromium and Electron accept it.
    pub user_data_dir: Option<PathBuf>,
    /// `--background`: a login launch. It starts the services and opens no window.
    pub background: bool,
}

impl LaunchArgs {
    /// Reads the switches from a full command line. Other arguments are ignored. When a switch
    /// repeats, the last one wins, as in Chromium.
    pub fn parse<I, S>(argv: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let mut args = Self::default();
        for arg in argv.into_iter().map(Into::into) {
            let text = arg.to_string_lossy();
            if text == "--background" {
                args.background = true;
            } else if let Some(dir) = text.strip_prefix("--user-data-dir=") {
                args.user_data_dir = (!dir.is_empty()).then(|| PathBuf::from(dir));
            }
        }
        args
    }
}

/// The user-data folder and the files the core keeps in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppPaths {
    user_data: PathBuf,
}

impl AppPaths {
    /// `--user-data-dir` when given (made absolute against the working folder), otherwise the
    /// platform default.
    pub fn resolve(args: &LaunchArgs) -> io::Result<Self> {
        let user_data = match &args.user_data_dir {
            Some(dir) => std::path::absolute(dir)?,
            None => default_user_data()?,
        };
        Ok(Self { user_data })
    }

    pub fn at(user_data: impl Into<PathBuf>) -> Self {
        Self {
            user_data: user_data.into(),
        }
    }

    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    pub fn config(&self) -> PathBuf {
        self.user_data.join("config.json")
    }

    pub fn state(&self) -> PathBuf {
        self.user_data.join("state")
    }

    pub fn log(&self) -> PathBuf {
        self.user_data.join("app.log")
    }
}

/// `%APPDATA%\chat-on-steroids`, `~/Library/Application Support/chat-on-steroids`, or the XDG
/// config folder: Electron's `userData` for this app.
pub fn default_user_data() -> io::Result<PathBuf> {
    let var = |name: &str| {
        std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let missing =
        |name: &str| io::Error::new(io::ErrorKind::NotFound, format!("{name} is not set"));
    let base = if cfg!(windows) {
        var("APPDATA").ok_or_else(|| missing("APPDATA"))?
    } else if cfg!(target_os = "macos") {
        var("HOME")
            .ok_or_else(|| missing("HOME"))?
            .join("Library")
            .join("Application Support")
    } else {
        match var("XDG_CONFIG_HOME") {
            Some(config) => config,
            None => var("HOME").ok_or_else(|| missing("HOME"))?.join(".config"),
        }
    };
    Ok(base.join(APP_DIR_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_switches_and_ignores_the_rest() {
        let args = LaunchArgs::parse([
            "app.exe",
            "--user-data-dir=D:\\profiles\\a",
            "chat://x",
            "--background",
        ]);
        assert_eq!(
            args,
            LaunchArgs {
                user_data_dir: Some(PathBuf::from("D:\\profiles\\a")),
                background: true
            }
        );
        assert_eq!(
            LaunchArgs::parse(["app.exe", "--background=1", "--user-data-dir"]),
            LaunchArgs::default()
        );
        let last = LaunchArgs::parse(["--user-data-dir=a", "--user-data-dir=b"]);
        assert_eq!(last.user_data_dir, Some(PathBuf::from("b")));
    }

    #[test]
    fn a_relative_profile_is_made_absolute() {
        let paths =
            AppPaths::resolve(&LaunchArgs::parse(["--user-data-dir=profile"])).expect("resolves");
        assert!(paths.user_data().is_absolute());
        assert!(
            paths
                .config()
                .ends_with(Path::new("profile").join("config.json"))
        );
    }
}

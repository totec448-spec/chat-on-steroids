use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use cos_types::app_state::SecureStorageInfo;

use crate::key::{self, MasterKey};
use crate::text::{clean_api_key, js_trim};
use crate::{Error, SecretKey, SecretMap, Unavailable, format};

const SECRETS_FILE: &str = "secrets.bin";

/// One profile's credential store, the state `secrets.ts` keeps in module variables.
///
/// Methods take `&mut self`, so one owner serializes every read-modify-write. That replaces the
/// TypeScript mutation queue, single-flight load and load generations, which exist only because
/// its async calls interleave. Share a store across threads behind a `Mutex`.
pub struct SecretStore {
    user_data: PathBuf,
    key: Option<MasterKey>,
    snapshot: Snapshot,
}

/// `cache` and `unreadable` in `secrets.ts`, as one value.
enum Snapshot {
    /// Not read yet, or secure storage was unavailable when it was read. The next call retries.
    Unknown,
    /// The authoritative contents of `secrets.bin`, empty when the file does not exist.
    Known(SecretMap),
    /// `secrets.bin` exists and the profile key cannot open it. The file is left untouched.
    Unreadable,
}

impl SecretStore {
    /// `initSecretsPath`: the store for the profile at `user_data`. Touches nothing on disk.
    pub fn new(user_data: impl Into<PathBuf>) -> Self {
        Self {
            user_data: user_data.into(),
            key: None,
            snapshot: Snapshot::Unknown,
        }
    }

    /// `secureStorageStatus` on Windows. A profile without `Local State` gets a new key here.
    pub fn status(&mut self) -> SecureStorageInfo {
        match self.key() {
            Ok(_) => SecureStorageInfo {
                available: true,
                detail: None,
            },
            Err(Unavailable::Unsupported { .. }) => SecureStorageInfo {
                available: false,
                detail: Some(
                    "Secure credential storage is not supported on this platform yet.".into(),
                ),
            },
            Err(_) => SecureStorageInfo {
                available: false,
                detail: Some(
                    "Secure operating-system credential storage is unavailable on this machine."
                        .into(),
                ),
            },
        }
    }

    /// `storedSecretsUnreadable`: the last read found a file the profile key cannot open.
    pub fn unreadable(&self) -> bool {
        matches!(self.snapshot, Snapshot::Unreadable)
    }

    /// `getSecret`: the stored value, or `None` when it is absent, empty, unreadable or secure
    /// storage is unavailable.
    pub fn get(&mut self, key: &SecretKey) -> Option<String> {
        let stored = self.load().ok()?.get(key.name().as_ref())?;
        let value = if key.is_api_key() {
            clean_api_key(stored)
        } else {
            stored.clone()
        };
        (!value.is_empty()).then_some(value)
    }

    /// `hasSecret`.
    pub fn has(&mut self, key: &SecretKey) -> bool {
        self.get(key).is_some()
    }

    /// `setSecret`: stores the cleaned value, or removes the key when nothing is left of it.
    /// Fails closed, changing nothing, when the current file cannot be read.
    pub fn set(&mut self, key: &SecretKey, value: &str) -> Result<(), Error> {
        self.key()?;
        let mut next = self.load()?.clone();
        let value = if key.is_api_key() {
            clean_api_key(value)
        } else {
            js_trim(value).to_owned()
        };
        if value.is_empty() {
            next.shift_remove(key.name().as_ref());
        } else {
            next.insert(key.name().into_owned(), value);
        }
        let blob = format::seal(self.key()?, &next);
        write_replacing(&self.secrets_path(), &blob)?;
        self.snapshot = Snapshot::Known(next);
        Ok(())
    }

    /// `clearSecret`.
    pub fn clear(&mut self, key: &SecretKey) -> Result<(), Error> {
        self.set(key, "")
    }

    /// `deleteAllSecrets`: removes `secrets.bin`, readable or not. Needs no key.
    pub fn delete_all(&mut self) -> io::Result<()> {
        self.snapshot = Snapshot::Unknown;
        match fs::remove_file(self.secrets_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.snapshot = Snapshot::Known(SecretMap::new());
        Ok(())
    }

    /// `setAsideUnreadableSecrets`: the user's way out of an unreadable file. Reads it once more,
    /// and only if it is still unreadable renames it to the returned
    /// `secrets.unreadable-YYYYMMDD-HHMMSS-mmm.bin` name (UTC) and starts an empty store.
    /// Returns `None`, changing nothing, when the file can be read.
    pub fn set_aside_unreadable(&mut self, now: SystemTime) -> Result<Option<String>, Error> {
        self.key()?;
        match self.load() {
            Ok(_) => return Ok(None),
            Err(Error::Unreadable) => {}
            Err(error) => return Err(error),
        }
        let name = set_aside_name(now);
        fs::rename(self.secrets_path(), self.user_data.join(&name))?;
        self.snapshot = Snapshot::Known(SecretMap::new());
        Ok(Some(name))
    }

    fn secrets_path(&self) -> PathBuf {
        self.user_data.join(SECRETS_FILE)
    }

    /// The profile key, loaded once. Unavailability is not remembered, so a later call retries.
    fn key(&mut self) -> Result<&MasterKey, Unavailable> {
        cached_key(&mut self.key, &self.user_data)
    }

    /// `readAll`: the known contents, reading `secrets.bin` again if they are not known yet.
    fn load(&mut self) -> Result<&SecretMap, Error> {
        if !matches!(self.snapshot, Snapshot::Known(_)) {
            let key = cached_key(&mut self.key, &self.user_data)?;
            self.snapshot = read_snapshot(key, &self.user_data.join(SECRETS_FILE));
        }
        match &self.snapshot {
            Snapshot::Known(values) => Ok(values),
            Snapshot::Unknown | Snapshot::Unreadable => Err(Error::Unreadable),
        }
    }
}

fn cached_key<'a>(
    slot: &'a mut Option<MasterKey>,
    user_data: &Path,
) -> Result<&'a MasterKey, Unavailable> {
    if slot.is_none() {
        *slot = Some(key::load_or_create(user_data)?);
    }
    Ok(slot.as_ref().expect("the key was stored above"))
}

/// `loadAll` once the key is available: a missing file is an empty store, and any other read
/// or decrypt failure leaves the file alone and marks it unreadable.
fn read_snapshot(key: &MasterKey, path: &Path) -> Snapshot {
    match fs::read(path) {
        Ok(blob) => format::open(key, &blob).map_or(Snapshot::Unreadable, Snapshot::Known),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Snapshot::Known(SecretMap::new()),
        Err(_) => Snapshot::Unreadable,
    }
}

/// `writeAll`: through `secrets.bin.tmp` and a rename, so a failed write leaves the old file.
fn write_replacing(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

/// The name `setAsideUnreadableSecrets` derives from `Date.toISOString()`.
fn set_aside_name(now: SystemTime) -> String {
    let since_epoch = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let millis = since_epoch.subsec_millis();
    let seconds = since_epoch.as_secs();
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    let second_of_day = seconds % 86_400;
    format!(
        "secrets.unreadable-{year:04}{month:02}{day:02}-{:02}{:02}{:02}-{millis:03}.bin",
        second_of_day / 3600,
        second_of_day / 60 % 60,
        second_of_day % 60,
    )
}

/// Proleptic Gregorian date of a day count since 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(millis: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(millis)
    }

    #[test]
    fn set_aside_names_match_the_typescript_stamp() {
        // Expected names from `setAsideUnreadableSecrets(new Date(ms))` for each instant.
        for (millis, name) in [
            (0, "secrets.unreadable-19700101-000000-000.bin"),
            (
                951_782_400_007,
                "secrets.unreadable-20000229-000000-007.bin",
            ),
            (
                1_760_918_399_999,
                "secrets.unreadable-20251019-235959-999.bin",
            ),
            (
                4_107_542_400_000,
                "secrets.unreadable-21000301-000000-000.bin",
            ),
            (
                253_402_300_799_999,
                "secrets.unreadable-99991231-235959-999.bin",
            ),
        ] {
            assert_eq!(set_aside_name(at(millis)), name, "{millis}");
        }
    }
}

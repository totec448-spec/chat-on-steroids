//! App identities and command-free executable launches.
//! All path launches are resolved to an existing .exe before invoking CreateProcess.
use super::policy;
use super::win::{self, Result, fail};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    process::Command,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::{FolderItem, FolderItem2, IShellDispatch, Shell};
use windows::core::{BSTR, Interface};

struct CatalogEntry {
    id: String,
    launch_id: String,
    name: String,
    process_path: String,
    native_id: String,
    native: FolderItem,
}

fn bounded(value: &str, limit: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > limit || value.contains(['\0', '\u{001f}']) {
        return None;
    }
    Some(value.to_owned())
}

fn shell_property(item: &FolderItem, name: &str) -> Option<String> {
    // Not every FolderItem supports FolderItem2 / extended properties; the
    // native shell identity (Path) remains available in those cases.
    let specialized: FolderItem2 = item.cast().ok()?;
    // SAFETY: BSTR + VARIANT are owned RAII values, retained for no longer than this call.
    let property = unsafe { specialized.ExtendedProperty(&BSTR::from(name)) }.ok()?;
    BSTR::try_from(&property)
        .ok()
        .and_then(|value| bounded(&value.to_string(), 2048))
}

fn catalog() -> Result<Vec<CatalogEntry>> {
    // SAFETY: COM is initialized once in initialize_com(); the Shell objects
    // and their iterated FolderItem references all remain on the owning thread.
    let shell: IShellDispatch =
        unsafe { CoCreateInstance(&Shell, None, CLSCTX_ALL) }.map_err(|_| {
            fail(
                "APP_CATALOG_UNAVAILABLE",
                "Windows Shell.Application catalog is unavailable",
            )
        })?;
    let folder = unsafe { shell.NameSpace(&VARIANT::from("shell:AppsFolder")) }.map_err(|_| {
        fail(
            "APP_CATALOG_UNAVAILABLE",
            "Windows AppsFolder is unavailable",
        )
    })?;
    let items = unsafe { folder.Items() }.map_err(|_| {
        fail(
            "APP_CATALOG_UNAVAILABLE",
            "Windows AppsFolder items are unavailable",
        )
    })?;
    let count = unsafe { items.Count() }.map_err(|_| {
        fail(
            "APP_CATALOG_UNAVAILABLE",
            "Windows app catalog count is unavailable",
        )
    })?;
    if !(0..=4096).contains(&count) {
        return Err(fail(
            "APP_CATALOG_LIMIT",
            "Windows app catalog exceeds 4096 items",
        ));
    }
    let mut entries = Vec::with_capacity(count as usize);
    for index in 0..count {
        let item = unsafe { items.Item(&VARIANT::from(index)) }.map_err(|_| {
            fail(
                "APP_CATALOG_UNAVAILABLE",
                "Windows app catalog item is unavailable",
            )
        })?;
        if unsafe { item.IsFolder() }.is_ok_and(|folder| folder.0 != 0) {
            continue;
        }
        let launch_id = unsafe { item.Path() }
            .ok()
            .and_then(|value| bounded(&value.to_string(), 2048));
        let Some(launch_id) = launch_id else {
            continue;
        };
        let native_id = shell_property(&item, "System.AppUserModel.ID").unwrap_or_default();
        let link_target =
            shell_property(&item, "System.Link.TargetParsingPath").unwrap_or_default();
        let target = if link_target.is_empty() && launch_id.to_ascii_lowercase().ends_with(".exe") {
            launch_id.as_str()
        } else {
            &link_target
        };
        let process_path =
            if Path::new(target).is_absolute() && target.to_ascii_lowercase().ends_with(".exe") {
                Path::new(target)
                    .canonicalize()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };
        let id = if !native_id.is_empty() {
            native_id.clone()
        } else if !process_path.is_empty() {
            process_path.to_lowercase()
        } else {
            launch_id.clone()
        };
        if bounded(&id, 2048).is_none() {
            continue;
        }
        let name = unsafe { item.Name() }
            .ok()
            .map(|value| value.to_string().chars().take(512).collect::<String>())
            .unwrap_or_default();
        entries.push(CatalogEntry {
            id,
            launch_id,
            name,
            process_path,
            native_id,
            native: item,
        });
    }
    Ok(entries)
}

fn candidate_executable(input: &str) -> Option<PathBuf> {
    if !input.to_ascii_lowercase().ends_with(".exe") || input.contains(['\0', '\n', '\r', '"']) {
        return None;
    }
    let absolute = input.starts_with("\\\\")
        || (input.len() >= 3
            && input.as_bytes()[1] == b':'
            && matches!(input.as_bytes()[2], b'/' | b'\\')
            && input.as_bytes()[0].is_ascii_alphabetic());
    let path = if absolute {
        PathBuf::from(input)
    } else if input.len() <= 512
        && input
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ' ' | '-'))
    {
        env::split_paths(&env::var_os("PATH")?)
            .map(|dir| dir.join(input))
            .find(|p| p.is_file())?
    } else {
        return None;
    };
    if !path.is_file()
        || path
            .extension()
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    path.canonicalize().ok()
}

pub(crate) fn launch(app: &str) -> Result<Value> {
    policy::require_native_effects()?;
    if app.is_empty() || app.len() > 32768 {
        return Err(fail(
            "BAD_REQUEST",
            "launch_app requires an app ID, executable path, or executable name",
        ));
    }
    let path = candidate_executable(app);
    if path.is_none() {
        let mut selected: Option<CatalogEntry> = None;
        for entry in catalog()? {
            if entry.id == app || entry.launch_id == app {
                if selected.is_some() {
                    return Err(fail("APP_ID_AMBIGUOUS", "installed app ID is not unique"));
                }
                selected = Some(entry);
            }
        }
        let chosen = selected.ok_or_else(||fail("APP_NOT_FOUND",
            "app ID or executable was not found; list apps or provide an existing .exe path/name"))?;
        // SAFETY: invoke only the fixed Shell open verb on a unique current
        // installed AppsFolder item; caller string is never a shell command.
        unsafe { chosen.native.InvokeVerb(&VARIANT::from("open")) }.map_err(|_| {
            fail(
                "APP_LAUNCH_FAILED",
                "Windows Shell could not open the installed app",
            )
        })?;
        return Ok(json!({"app":app,"displayName":chosen.name,
            "status":"launch_requested","windowConfirmed":false}));
    }
    let path = path.ok_or_else(|| fail("APP_NOT_FOUND", "executable not found"))?;
    // Only an exact existing executable, no shell, no arguments. An observed app catalog
    // needs a separately verified native Shell item identity before exposing open verbs.
    let process = Command::new(&path)
        .current_dir(path.parent().unwrap_or(Path::new(".")))
        .spawn()
        .map_err(|_| fail("APP_LAUNCH_FAILED", "Windows did not start the executable"))?;
    Ok(
        json!({"app":path.to_string_lossy().to_lowercase(),"status":"launch_requested",
       "windowConfirmed":false,"processId":process.id()}),
    )
}

pub(crate) fn list(query: &Value) -> Result<Value> {
    let match_value = query.get("match").and_then(Value::as_str).unwrap_or("");
    if match_value.chars().count() > 128 {
        return Err(fail("BAD_REQUEST", "app query exceeds 128 characters"));
    }
    let limit = query
        .get("limit")
        .and_then(Value::as_u64)
        .map_or(4096, |n| n.clamp(1, 4096) as usize);
    // An exact native Windows Shell catalog includes installed apps with no windows.
    // Running windows with different paths/AUMIDs are never merged by process names.
    let mut apps: BTreeMap<String, Value> = BTreeMap::new();
    for entry in catalog()? {
        apps.entry(entry.id.clone()).or_insert_with(|| {
            json!({"id":entry.id,"displayName":entry.name,"windows":[],
                "processPath":entry.process_path,"appUserModelId":entry.native_id})
        });
    }
    for window in win::windows() {
        let app = window["app"].as_str().unwrap_or("").to_owned();
        if app.is_empty() {
            continue;
        }
        let display = window["process"].as_str().unwrap_or("").to_owned();
        let row = apps.entry(app.clone()).or_insert_with(
            || json!({"id":app,"displayName":display,"windows":[],"isRunning":true}),
        );
        if let Some(children) = row["windows"].as_array_mut() {
            children.push(window);
        }
    }
    let needle = match_value.to_lowercase();
    let mut rows = apps
        .into_values()
        .filter(|row| {
            row["id"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&needle)
                || row["displayName"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&needle)
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        let a_running = a["windows"]
            .as_array()
            .is_some_and(|windows| !windows.is_empty());
        let b_running = b["windows"]
            .as_array()
            .is_some_and(|windows| !windows.is_empty());
        b_running
            .cmp(&a_running)
            .then_with(|| {
                a["displayName"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&b["displayName"].as_str().unwrap_or("").to_lowercase())
            })
            .then_with(|| {
                a["id"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["id"].as_str().unwrap_or(""))
            })
    });
    let total = rows.len();
    rows.truncate(limit);
    Ok(json!({"apps":rows,"total":total,"truncated":total>rows.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_id_cannot_be_shell_script_or_command() {
        for case in [
            "notepad.exe --flag",
            "notepad.exe; command",
            ".\\notepad.exe",
            "https://example.com/app.exe",
            "notepad.exe\n",
            "fake.exe\"",
        ] {
            assert!(candidate_executable(case).is_none(), "{case}");
        }
    }
}

/** Native window identity shared by discovery, app grouping, and exact-window actions. */
export const WINDOWS_APP_IDENTITY_SOURCE = String.raw`
public static class CosWindowsAppIdentity {
  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid Format; public uint Id; }
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PROPVARIANT { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT value);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder value);

  static string Bounded(string value) {
    return !String.IsNullOrWhiteSpace(value) && value.Length <= 2048 && value.IndexOf((char)31) < 0 ? value : "";
  }
  static string WindowAppId(IntPtr window) {
    IPropertyStore store = null;
    var value = new PROPVARIANT();
    try {
      Guid iid = typeof(IPropertyStore).GUID;
      if (SHGetPropertyStoreForWindow(window, ref iid, out store) < 0 || store == null) return "";
      var key = new PROPERTYKEY { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
      if (store.GetValue(ref key, out value) < 0 || value.Type != 31 || value.Pointer == IntPtr.Zero) return "";
      return Bounded(Marshal.PtrToStringUni(value.Pointer));
    } catch { return ""; }
    finally {
      PropVariantClear(ref value);
      if (store != null && Marshal.IsComObject(store)) Marshal.ReleaseComObject(store);
    }
  }
  // app identifier, process image path, native AppUserModelID. No process-name joins.
  public static string[] Read(long handle, uint processId) {
    string appId = WindowAppId(new IntPtr(handle));
    string path = "";
    IntPtr process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
    if (process != IntPtr.Zero) {
      try {
        uint size = 32768;
        var buffer = new StringBuilder((int)size);
        if (QueryFullProcessImageNameW(process, 0, buffer, ref size)) path = Bounded(buffer.ToString());
        if (appId.Length == 0) {
          size = 2048;
          buffer = new StringBuilder((int)size);
          if (GetApplicationUserModelId(process, ref size, buffer) == 0) appId = Bounded(buffer.ToString());
        }
      } finally { CloseHandle(process); }
    }
    return new string[] { appId.Length > 0 ? appId : path.ToLowerInvariant(), path, appId };
  }
}
`;

/** Windows owns catalog and process identities; launches never parse a shell command. */
export const WINDOWS_APPS_SCRIPT = String.raw`
function Release-AppCom($value) {
  if ($null -ne $value -and [System.Runtime.InteropServices.Marshal]::IsComObject($value)) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($value)
  }
}

function Get-AppCatalogIdentity($item) {
  $launchId = [string]$item.Path
  $nativeId = ''; $targetPath = ''
  try { $value = $item.ExtendedProperty('System.AppUserModel.ID'); if ($value -is [string]) { $nativeId = $value } } catch { }
  try { $value = $item.ExtendedProperty('System.Link.TargetParsingPath'); if ($value -is [string]) { $targetPath = $value } } catch { }
  if (!$targetPath -and [IO.Path]::IsPathRooted($launchId) -and $launchId.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { $targetPath = $launchId }
  if ($targetPath -and $targetPath.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::IsPathRooted($targetPath)) {
    try { $targetPath = [IO.Path]::GetFullPath($targetPath) } catch { $targetPath = '' }
  } else { $targetPath = '' }
  $id = if ($nativeId) { $nativeId } elseif ($targetPath) { $targetPath.ToLowerInvariant() } else { $launchId }
  if ([string]::IsNullOrWhiteSpace($id) -or $id.Length -gt 2048) { return $null }
  $name = [string]$item.Name
  return @{ id = $id; launchId = $launchId; displayName = $name.Substring(0, [Math]::Min(512, $name.Length)); processPath = $targetPath; appUserModelId = $nativeId }
}

function Resolve-AppExecutable([string]$appId) {
  if (!$appId.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or $appId.IndexOfAny([char[]]@([char]0,[char]10,[char]13,[char]34)) -ge 0) { return $null }
  if ($appId -match '^(?:[A-Za-z]:[\\/]|\\\\)') {
    try { $candidate = [IO.Path]::GetFullPath($appId) } catch { return $null }
  } elseif ($appId -match '^[A-Za-z0-9_. -]+\.exe$') {
    # Application-only PATH lookup, never aliases/functions, and no arguments.
    $command = Get-Command -Name $appId -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { return $null }
    $candidate = $command.Source
  } else { return $null }
  if (![IO.File]::Exists($candidate) -or !([IO.Path]::GetExtension($candidate).Equals('.exe', [StringComparison]::OrdinalIgnoreCase))) { return $null }
  return $candidate
}

function Start-AppExecutable([string]$path) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $path
  $start.Arguments = ''
  $start.UseShellExecute = $false
  $start.WorkingDirectory = [IO.Path]::GetDirectoryName($path)
  $process = [System.Diagnostics.Process]::Start($start)
  if ($null -eq $process) { throw 'APP_LAUNCH_FAILED: Windows did not start the executable' }
  try { return @{ app = $path.ToLowerInvariant(); status = 'launch_requested'; windowConfirmed = $false; processId = $process.Id } }
  finally { $process.Dispose() }
}

function Invoke-WindowsAppsCatalog($request, [bool]$launch) {
  $query = if ($request.match) { [string]$request.match } else { '' }
  if ($query.Length -gt 128) { throw 'BAD_REQUEST: app query exceeds 128 characters' }
  $limit = if ($request.limit) { [Math]::Max(1, [Math]::Min(4096, [int]$request.limit)) } else { 4096 }
  $appId = if ($request.app) { [string]$request.app } else { '' }
  if ($launch -and ([string]::IsNullOrWhiteSpace($appId) -or $appId.Length -gt 32768)) {
    throw 'BAD_REQUEST: launch_app requires an app ID, executable path, or executable name'
  }
  if ($launch) {
    $executable = Resolve-AppExecutable $appId
    if ($null -ne $executable) { return Start-AppExecutable $executable }
  }
  $shell = $null; $folder = $null; $items = $null; $selected = $null
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.NameSpace('shell:AppsFolder')
    if ($null -eq $folder) { throw 'APP_CATALOG_UNAVAILABLE: Windows AppsFolder is unavailable' }
    $items = $folder.Items()
    if ($items.Count -gt 4096) { throw 'APP_CATALOG_LIMIT: Windows app catalog exceeds 4096 items' }
    $catalog = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    for ($index = 0; $index -lt $items.Count; $index++) {
      $item = $items.Item($index)
      try {
        if ($item.IsFolder) { continue }
        $identity = Get-AppCatalogIdentity $item
        if ($null -eq $identity) { continue }
        $id = $identity.id
        if ($launch) {
          if ($id -ceq $appId -or $identity.launchId -ceq $appId) {
            if ($null -ne $selected) { throw 'APP_ID_AMBIGUOUS: installed app ID is not unique' }
            $selected = $item
            $item = $null
            $selectedName = $identity.displayName
          }
        } elseif (!$catalog.ContainsKey($id)) {
          $catalog.Add($id, @{ id = $id; displayName = $identity.displayName; windows = @() })
        }
      } finally { Release-AppCom $item }
    }
    if ($launch) {
      if ($null -eq $selected) {
        throw 'APP_NOT_FOUND: app ID or executable was not found; list apps or provide an existing .exe path/name'
      }
      # Catalog items keep their native launch verb; explicit executables above use
      # ProcessStartInfo with no shell and no command-line arguments.
      $selected.InvokeVerb('open')
      return @{ app = $appId; displayName = $selectedName; status = 'launch_requested'; windowConfirmed = $false }
    }
    foreach ($window in @(Get-WindowRows)) {
      if (!$window.app) { continue }
      if (!$catalog.ContainsKey([string]$window.app)) {
        $catalog.Add([string]$window.app, @{ id = [string]$window.app; displayName = [string]$window.process; windows = @() })
      }
      $row = $catalog[[string]$window.app]
      $row.windows += $window
      $row.isRunning = $true
    }
    $matching = @($catalog.Values | Where-Object { !$query -or $_.displayName.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.id.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Sort-Object @{Expression={if ($_.windows.Count -gt 0) {0} else {1}}},displayName,id)
    $rows = @($matching | Select-Object -First $limit)
    return @{ apps = $rows; total = $matching.Count; truncated = ($matching.Count -gt $rows.Count) }
  } finally {
    Release-AppCom $selected
    Release-AppCom $items
    Release-AppCom $folder
    Release-AppCom $shell
  }
}

function Get-WindowsApps($request) { return Invoke-WindowsAppsCatalog $request $false }
function Launch-WindowsApp($request) { return Invoke-WindowsAppsCatalog $request $true }
`;

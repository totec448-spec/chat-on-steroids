//! CPU time of the calling thread. The script budget counts what the QuickJS thread computed,
//! not wall time it spent descheduled (#1367), as Node's `process.threadCpuUsage` does.

use std::time::Duration;

#[cfg(windows)]
pub(crate) fn thread_cpu() -> Duration {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};

    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: GetCurrentThread returns a pseudo-handle that is always valid for the calling
    // thread, and every out-pointer refers to a live, writable FILETIME on this stack frame.
    let ok = unsafe {
        GetThreadTimes(
            GetCurrentThread(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return Duration::ZERO;
    }
    let ticks =
        |time: FILETIME| u64::from(time.dwHighDateTime) << 32 | u64::from(time.dwLowDateTime);
    // FILETIME counts 100 ns intervals.
    Duration::from_nanos((ticks(kernel) + ticks(user)).saturating_mul(100))
}

#[cfg(not(windows))]
pub(crate) fn thread_cpu() -> Duration {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `time` is a live, writable timespec, and CLOCK_THREAD_CPUTIME_ID is supported on
    // every platform this crate builds for (Linux and macOS).
    let status = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) };
    if status != 0 {
        return Duration::ZERO;
    }
    Duration::new(
        u64::try_from(time.tv_sec).unwrap_or(0),
        u32::try_from(time.tv_nsec).unwrap_or(0),
    )
}

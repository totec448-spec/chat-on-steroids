//! `Date.prototype.toISOString` for an epoch-millisecond time: `2026-10-20T08:15:30.123Z`.

use cos_tools::EpochMs;

pub(crate) fn iso_time(at: EpochMs) -> String {
    let millis = at.0 % 1000;
    let seconds = at.0 / 1000;
    let (days, of_day) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// Howard Hinnant's `civil_from_days`, for days since 1970-01-01 (never before it here).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(iso_time(EpochMs(0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_time(EpochMs(951_782_400_000)),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            iso_time(EpochMs(1_792_484_130_123)),
            "2026-10-20T08:15:30.123Z"
        );
    }
}

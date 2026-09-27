//! One append-only diagnostic log shared by the shell's threads.
//!
//! The ball is a GUI process spawned by the plugin, so its stdout is easy to lose. Everything worth
//! reconstructing later - lifecycle, geometry, selection reads - is appended to a file whose path the
//! plugin passes in `BUBBLE_LOG_FILE`.

use std::io::Write;

/// File the shell appends lifecycle, geometry, and selection lines to.
fn path() -> std::path::PathBuf {
    std::env::var("BUBBLE_LOG_FILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("dsh-bubble-shell.log"))
}

/// Append one timestamped line. Logging never fails a caller and never panics.
pub fn line(message: &str) {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path())
    {
        let _ = writeln!(file, "{millis} {message}");
    }
}

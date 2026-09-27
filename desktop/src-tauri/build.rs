fn main() {
    // Windows gives a process's first thread 1 MiB of stack. WebView2, COM, and the tray/menu
    // plumbing all recurse through it, and a 0xC00000FD (STATUS_STACK_OVERFLOW) kills the whole
    // ball - both windows vanish at once and the plugin has to restart it, which the user sees as
    // the floating ball blinking out. Reserve far more than any of those call chains can need; the
    // commit size stays on demand, so idle memory does not grow.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/STACK:16777216");
    } else if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
        println!("cargo:rustc-link-arg=-Wl,--stack,16777216");
    }
    tauri_build::build()
}

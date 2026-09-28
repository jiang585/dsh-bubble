//! DSH Bubble floating-ball window shell.
//!
//! The plugin's host half spawns this executable and passes the ball's persisted geometry plus the
//! plugin HTTP endpoint through the environment. This shell owns the native window: it draws no
//! product UI, it keeps the ball and panel rectangles in place and hands the page the geometry it
//! must render. Geometry is expressed in logical pixels, exactly like the DeepSeek Orb desktop
//! shell's device-independent coordinates.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod geometry;
mod log;
mod selection;

use geometry::{
    ball_origin_from_window, clamped_ball_origin, collapsed_window_rect, default_ball_origin,
    dock_side_for_ball_origin, docked_window_rect, expanded_overlay_bounds, inside_ball_origin,
    off_screen_ball_origin, stays_docked, Direction, DockSide, Horizontal, Point, Rect, Vertical,
    BALL_SIZE,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, PhysicalPosition, State,
    WebviewWindow,
};

/// Live window geometry and the dock state it was derived from.
struct BubbleState {
    ball: Point,
    direction: Direction,
    expanded: bool,
    docked: Option<DockSide>,
    /// Ball origin `y` remembered while docked so the tab stays where the ball was.
    docked_y: i32,
    /// Whether the geometry was resolved from the environment and the monitors yet.
    placed: bool,
}

/// Geometry snapshot returned to the page after every window operation.
#[derive(Clone, Copy, Serialize)]
struct BubbleSnapshot {
    /// Current ball top-left in logical pixels.
    ball: Point,
    /// Panel growth in use.
    direction: Direction,
    /// Whether the panel is expanded.
    expanded: bool,
    /// Docked edge, when the ball is a tab.
    docked: Option<DockSide>,
}

impl BubbleState {
    /// State before the environment and monitors were read.
    ///
    /// The window declared in `tauri.conf.json` starts loading its page before `setup` runs, so a
    /// placeholder must already be managed: the page's first `bubble_state` otherwise fails with
    /// "state not managed" and the renderer falls back to guessing the ball origin.
    fn placeholder() -> Self {
        Self {
            ball: Point { x: 0, y: 0 },
            direction: Direction {
                horizontal: Horizontal::Right,
                vertical: Vertical::Down,
            },
            expanded: false,
            docked: None,
            docked_y: 0,
            placed: false,
        }
    }

    fn snapshot(&self) -> BubbleSnapshot {
        BubbleSnapshot {
            ball: self.ball,
            direction: self.direction,
            expanded: self.expanded,
            docked: self.docked,
        }
    }
}

/// Endpoint, token, and locale handed in by the plugin at spawn time.
#[derive(Serialize)]
struct BubbleEnvironment {
    /// Plugin HTTP base, for example `http://127.0.0.1:19387/dsh-bubble`.
    api_base: String,
    /// Per-launch token the plugin requires on every request from this window.
    token: String,
    /// UI language, `zh` or `en`.
    locale: String,
    /// Painted ball diameter in logical pixels.
    ball_size: i32,
}

fn env_or(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn parse_env_i32(name: &str) -> Option<i32> {
    std::env::var(name).ok()?.trim().parse::<i32>().ok()
}

/// Record panics before the abort, so a dying shell leaves a reason behind.
fn install_crash_log() {
    std::panic::set_hook(Box::new(|info| {
        crate::log::line(&format!("PANIC {info}"));
    }));
}

/// Win32 `EXCEPTION_RECORD`, declared only as far as this file reads it.
#[repr(C)]
struct ExceptionRecord {
    /// Exception code, for example `0xC0000005` for an access violation.
    code: u32,
    /// Exception flags.
    flags: u32,
    /// Chained exception, unused here.
    record: *mut ExceptionRecord,
    /// Address where the exception happened.
    address: *mut core::ffi::c_void,
    /// Exception information words.
    parameters: [usize; 15],
}

/// Win32 `EXCEPTION_POINTERS`.
#[repr(C)]
struct ExceptionPointers {
    /// The exception itself.
    record: *mut ExceptionRecord,
    /// The captured CPU context, unused here.
    context: *mut core::ffi::c_void,
}

unsafe extern "system" {
    /// Install the process-wide last-chance exception filter.
    fn SetUnhandledExceptionFilter(
        filter: Option<unsafe extern "system" fn(*mut ExceptionPointers) -> i32>,
    ) -> *mut core::ffi::c_void;
}

/// Log an unhandled exception code before the process dies.
unsafe extern "system" fn log_unhandled_exception(info: *mut ExceptionPointers) -> i32 {
    if !info.is_null() && !(*info).record.is_null() {
        let record = (*info).record;
        crate::log::line(&format!(
            "FATAL unhandled exception code=0x{:08X} address={:?}",
            (*record).code, (*record).address
        ));
    }
    // EXCEPTION_CONTINUE_SEARCH: keep the default handler, so Windows still reports the crash.
    0
}

/// Record crashes that never reach a Rust panic, so a dead shell still explains itself.
fn install_exception_log() {
    unsafe {
        SetUnhandledExceptionFilter(Some(log_unhandled_exception));
    }
}

/// Monitor work area in logical pixels that contains `point`, or the nearest one.
fn work_area_for(app: &AppHandle, point: Point) -> Rect {
    let fallback = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    let Ok(monitors) = app.available_monitors() else {
        return fallback;
    };
    let mut nearest: Option<(Rect, i64)> = None;
    for monitor in &monitors {
        let scale = monitor.scale_factor();
        if scale <= 0.0 {
            continue;
        }
        let area = monitor.work_area();
        let rect = Rect {
            x: (area.position.x as f64 / scale).round() as i32,
            y: (area.position.y as f64 / scale).round() as i32,
            width: (area.size.width as f64 / scale).round() as i32,
            height: (area.size.height as f64 / scale).round() as i32,
        };
        if point.x >= rect.x
            && point.x < rect.x + rect.width
            && point.y >= rect.y
            && point.y < rect.y + rect.height
        {
            return rect;
        }
        let dx = (point.x - (rect.x + rect.width / 2)) as i64;
        let dy = (point.y - (rect.y + rect.height / 2)) as i64;
        let distance = dx * dx + dy * dy;
        if nearest.is_none_or(|(_, best)| distance < best) {
            nearest = Some((rect, distance));
        }
    }
    nearest.map(|(rect, _)| rect).unwrap_or(fallback)
}

/// Move and resize the window in a single Win32 call.
///
/// `set_size` followed by `set_position` is two window operations. Between them the window is composited
/// at its old origin with its new size, which the user sees as a flash of misplaced content on every
/// expand and collapse. `SetWindowPos` applies position and size together, so that frame never exists.
fn apply_rect(window: &WebviewWindow, rect: Rect) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

    let Ok(handle) = window.hwnd() else {
        // No handle (a platform without one): keep the two-call path rather than doing nothing.
        let _ = window.set_size(LogicalSize::new(rect.width as f64, rect.height as f64));
        let _ = window.set_position(LogicalPosition::new(rect.x as f64, rect.y as f64));
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let x = (rect.x as f64 * scale).round() as i32;
    let y = (rect.y as f64 * scale).round() as i32;
    let width = (rect.width as f64 * scale).round() as i32;
    let height = (rect.height as f64 * scale).round() as i32;
    unsafe {
        let _ = SetWindowPos(
            HWND(handle.0 as *mut core::ffi::c_void),
            None,
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn publish(window: &WebviewWindow, state: &BubbleState) -> BubbleSnapshot {
    let snapshot = state.snapshot();
    let _ = window.emit("bubble:geometry", snapshot);
    snapshot
}

/// Start geometry: persisted ball origin when the plugin supplied one, else the default edge.
fn initial_state(app: &AppHandle) -> BubbleState {
    let ball = match (parse_env_i32("BUBBLE_BALL_X"), parse_env_i32("BUBBLE_BALL_Y")) {
        (Some(x), Some(y)) => clamped_ball_origin(Point { x, y }, work_area_for(app, Point { x, y })),
        _ => default_ball_origin(work_area_for(app, Point { x: 0, y: 0 })),
    };
    let horizontal = match env_or("BUBBLE_DIRECTION_H", "right").as_str() {
        "left" => Horizontal::Left,
        _ => Horizontal::Right,
    };
    let vertical = match env_or("BUBBLE_DIRECTION_V", "down").as_str() {
        "up" => Vertical::Up,
        _ => Vertical::Down,
    };
    let docked = match env_or("BUBBLE_DOCKED", "").as_str() {
        "left" => Some(DockSide::Left),
        "right" => Some(DockSide::Right),
        _ => None,
    };
    BubbleState {
        ball,
        direction: Direction {
            horizontal,
            vertical,
        },
        expanded: false,
        docked,
        docked_y: ball.y,
        placed: true,
    }
}

/// Resolve the real geometry the first time any command needs it.
fn ensure_placed(app: &AppHandle, state: &mut BubbleState) {
    if state.placed {
        return;
    }
    *state = initial_state(app);
}

/// Place the collapsed ball window, or its docked tab, for the current state.
fn place_collapsed(window: &WebviewWindow, state: &BubbleState) {
    match state.docked {
        Some(side) => {
            let area = work_area_for(window.app_handle(), state.ball);
            apply_rect(window, docked_window_rect(side, state.docked_y, area));
        }
        None => apply_rect(window, collapsed_window_rect(state.ball)),
    }
}

/// Current ball origin, growth, and dock state.
#[tauri::command]
fn bubble_state(app: AppHandle, state: State<'_, Mutex<BubbleState>>) -> BubbleSnapshot {
    let mut state = state.lock().unwrap();
    ensure_placed(&app, &mut state);
    state.snapshot()
}

/// Endpoint, token, locale, and ball size the page must use.
#[tauri::command]
fn bubble_environment() -> BubbleEnvironment {
    BubbleEnvironment {
        api_base: env_or("BUBBLE_API_BASE", "http://127.0.0.1:19387/dsh-bubble"),
        token: env_or("BUBBLE_TOKEN", ""),
        locale: env_or("BUBBLE_LOCALE", "zh"),
        ball_size: BALL_SIZE,
    }
}

/// Expand or collapse the panel, keeping the ball origin fixed.
#[tauri::command]
fn bubble_set_expanded(
    window: WebviewWindow,
    state: State<'_, Mutex<BubbleState>>,
    expanded: bool,
) -> BubbleSnapshot {
    let mut state = state.lock().unwrap();
    ensure_placed(window.app_handle(), &mut state);
    if expanded {
        let (bounds, direction) =
            expanded_overlay_bounds(state.ball, work_area_for(window.app_handle(), state.ball));
        state.direction = direction;
        state.expanded = true;
        apply_rect(&window, bounds);
    } else {
        state.expanded = false;
        place_collapsed(&window, &state);
    }
    publish(&window, &state)
}

/// Move the ball during a drag, or the expanded panel before it collapses.
#[tauri::command]
fn bubble_move_ball(
    window: WebviewWindow,
    state: State<'_, Mutex<BubbleState>>,
    x: i32,
    y: i32,
    can_dock: bool,
) -> BubbleSnapshot {
    let mut state = state.lock().unwrap();
    ensure_placed(window.app_handle(), &mut state);
    let origin = Point { x, y };
    if state.expanded {
        let (bounds, direction) =
            expanded_overlay_bounds(origin, work_area_for(window.app_handle(), origin));
        state.ball = ball_origin_from_window(bounds, direction);
        state.direction = direction;
        apply_rect(&window, bounds);
    } else if !can_dock {
        state.docked = None;
        state.ball = origin;
        place_collapsed(&window, &state);
    } else {
        let area = work_area_for(window.app_handle(), origin);
        match state.docked {
            Some(side) if stays_docked(side, origin.x, area) => {
                state.docked_y = origin.y;
                state.ball = origin;
                apply_rect(&window, docked_window_rect(side, origin.y, area));
            }
            _ => {
                state.docked = None;
                state.ball = origin;
                place_collapsed(&window, &state);
            }
        }
    }
    publish(&window, &state)
}

/// Clamp on pointer-up, entering a docked tab when the ball already overlaps an edge.
#[tauri::command]
fn bubble_clamp(window: WebviewWindow, state: State<'_, Mutex<BubbleState>>, can_dock: bool) -> BubbleSnapshot {
    let mut state = state.lock().unwrap();
    ensure_placed(window.app_handle(), &mut state);
    if state.expanded {
        return publish(&window, &state);
    }
    let area = work_area_for(window.app_handle(), state.ball);
    match state.docked {
        Some(side) => {
            state.docked_y = state.ball.y;
            apply_rect(&window, docked_window_rect(side, state.docked_y, area));
        }
        None => match if can_dock {
            dock_side_for_ball_origin(state.ball, area)
        } else {
            None
        } {
            Some(side) => {
                state.docked = Some(side);
                state.docked_y = state.ball.y;
                apply_rect(&window, docked_window_rect(side, state.docked_y, area));
            }
            None => {
                state.ball = clamped_ball_origin(state.ball, area);
                place_collapsed(&window, &state);
            }
        },
    }
    publish(&window, &state)
}

/// Slide the ball back on-screen from a docked tab.
#[tauri::command]
fn bubble_unsnap(window: WebviewWindow, state: State<'_, Mutex<BubbleState>>) -> BubbleSnapshot {
    let mut state = state.lock().unwrap();
    ensure_placed(window.app_handle(), &mut state);
    if let Some(side) = state.docked {
        let area = work_area_for(window.app_handle(), state.ball);
        let inside = inside_ball_origin(side, state.docked_y, area);
        let off = off_screen_ball_origin(side, state.docked_y, area);
        state.docked = None;
        state.ball = inside;
        apply_rect(&window, collapsed_window_rect(off));
        apply_rect(&window, collapsed_window_rect(inside));
    }
    publish(&window, &state)
}

/// Hide the ball window without ending the plugin.
#[tauri::command]
fn bubble_hide(window: WebviewWindow) {
    let _ = window.hide();
}

/// End this desktop shell; the plugin decides whether to spawn another.
#[tauri::command]
fn bubble_quit(app: AppHandle) {
    app.exit(0);
}

/// Open one http(s) URL in the user's default browser.
///
/// `ShellExecuteW` hands the URL to the shell's default handler. The obvious alternative - spawning
/// `cmd /C start "" <url>` - makes Windows allocate a console for the child, and because this process
/// is a GUI subsystem app that console is a real window: a black box that flashes on screen before
/// the browser appears. ShellExecuteW creates no process of ours at all.
#[tauri::command]
fn bubble_open_url(url: String) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are supported".into());
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(target.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports values above 32 on success; 32 and below are error codes.
    if (result.0 as isize) <= 32 {
        return Err(format!("cannot open the URL (ShellExecuteW returned {})", result.0 as isize));
    }
    Ok(())
}

/// Record the panel build the webview reports at startup.
///
/// The panel is embedded in this executable, so a stale shell silently serves an old UI while every
/// file on disk still looks current. Writing the revision into the log makes that visible after the
/// fact, which is how a stale panel was found once already.
#[tauri::command]
fn bubble_panel_ready(revision: String) {
    crate::log::line(&format!("panel: revision {revision}"));
}

/// Id of the process that started this shell, which is the DSH host.
fn parent_process_id() -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let own = std::process::id();
        let mut parent = None;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == own {
                    parent = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        parent
    }
}

/// Full image path of a process, when the caller may query it.
fn process_image_path(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

/// Every process id currently running an image with the given full path.
fn pids_running(image: &str) -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut pids = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return pids;
        };
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                if pid != 0 {
                    if let Some(path) = process_image_path(pid) {
                        if path.eq_ignore_ascii_case(image) {
                            pids.push(pid);
                        }
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    pids
}

/// Largest visible top-level window owned by any of `pids`, with its title.
fn largest_window_of(pids: &[u32]) -> Option<(windows::Win32::Foundation::HWND, String)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    /// Carries the search state through `EnumWindows`.
    struct Search<'a> {
        /// Processes whose windows are wanted.
        pids: &'a [u32],
        /// Best handle found so far, as a raw pointer value.
        best: isize,
        /// Area of the best handle, so the main window wins over tooltips and shadows.
        area: i64,
    }

    unsafe extern "system" fn visit(window: HWND, param: LPARAM) -> BOOL {
        let search = &mut *(param.0 as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if search.pids.contains(&pid) && IsWindowVisible(window).as_bool() {
            let mut rect = RECT::default();
            if GetWindowRect(window, &mut rect).is_ok() {
                let area = i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top);
                if area > search.area {
                    search.area = area;
                    search.best = window.0 as isize;
                }
            }
        }
        BOOL(1)
    }

    let mut search = Search {
        pids,
        best: 0,
        area: 0,
    };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
        if search.best == 0 {
            return None;
        }
        let window = HWND(search.best as *mut core::ffi::c_void);
        let length = GetWindowTextLengthW(window);
        let mut buffer = vec![0u16; length as usize + 1];
        let written = GetWindowTextW(window, &mut buffer);
        Some((window, String::from_utf16_lossy(&buffer[..written as usize])))
    }
}

/// Resolve the host window for `--focus-main-check`, optionally against an explicit process id.
fn host_main_window_for(pid: Option<u32>) -> Result<(windows::Win32::Foundation::HWND, String), String> {
    let pid = match pid {
        Some(value) => value,
        None => parent_process_id().ok_or("找不到启动悬浮球壳的进程")?,
    };
    let image = process_image_path(pid).ok_or("无法读取宿主进程的可执行文件路径")?;
    let pids = pids_running(&image);
    if pids.is_empty() {
        return Err("找不到与宿主同属一个应用的进程".into());
    }
    let (window, title) = largest_window_of(&pids).ok_or("宿主应用当前没有可见窗口")?;
    Ok((window, title))
}

/// The DSH application window, resolved through the executable that launched this shell.
///
/// The immediate parent is an Electron helper process, and helper processes own no windows at all, so
/// the resolution matches every process running the same executable image and takes the largest visible
/// window among them. `Err` carries why it failed, because a silent no-op on the button is worse than
/// an error the panel can show.
fn host_main_window() -> Result<(windows::Win32::Foundation::HWND, String), String> {
    host_main_window_for(None)
}

/// Raise one window to the foreground, working around the Windows foreground lock.
///
/// A process that is not already foreground may not call `SetForegroundWindow` successfully; Windows
/// silently ignores it and only flashes the taskbar. Attaching to the foreground thread's input queue
/// for the duration of the call is the documented way around that.
fn raise_window(window: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    unsafe {
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        let target_thread = GetWindowThreadProcessId(window, None);
        let foreground = GetForegroundWindow();
        let foreground_thread = if foreground.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground, None)
        };
        let own_thread = GetCurrentThreadId();

        let attached_foreground =
            foreground_thread != 0 && AttachThreadInput(own_thread, foreground_thread, true).as_bool();
        let attached_target =
            target_thread != 0 && target_thread != own_thread && AttachThreadInput(own_thread, target_thread, true).as_bool();

        let _ = BringWindowToTop(window);
        let _ = SetForegroundWindow(window);
        let _ = SetActiveWindow(window);

        if attached_target {
            let _ = AttachThreadInput(own_thread, target_thread, false);
        }
        if attached_foreground {
            let _ = AttachThreadInput(own_thread, foreground_thread, false);
        }

        GetForegroundWindow() == HWND(window.0)
    }
}

/// Attention-grabbing taskbar flash, used when the window must not steal focus.
fn flash_window(window: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_ALL, FLASHW_TIMERNOFG,
    };

    let mut info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: window,
        dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
        uCount: 0,
        dwTimeout: 0,
    };
    unsafe {
        let _ = FlashWindowEx(&mut info);
    }
}

/**
 * Bring the DSH window to the foreground.
 *
 * The ball is a child of the DSH host, and the host owns the only surface that can answer an
 * `ask_user_question` prompt (the `userQuestions` service allows one provider). When the agent is
 * blocked on the user, this is the button that puts them in front of the window that can answer.
 */
#[tauri::command]
fn bubble_focus_main() -> Result<(), String> {
    let (window, title) = host_main_window()?;
    let raised = raise_window(window);
    crate::log::line(&format!(
        "focus: target={title:?} handled={} raised={raised}",
        !window.0.is_null()
    ));
    if !raised {
        return Err("系统拒绝了窗口激活（前台锁），已改为闪烁任务栏提示".into());
    }
    Ok(())
}

/// Flash the DSH window in the taskbar without taking focus.
#[tauri::command]
fn bubble_flash_main() -> Result<(), String> {
    let (window, _title) = host_main_window()?;
    flash_window(window);
    crate::log::line("focus: flashed the host window taskbar button");
    Ok(())
}

/// One-shot diagnostic used by `--focus-main-check[=pid]`: resolve and report, change nothing.
pub fn focus_main_check(explicit_pid: Option<u32>) {
    let source = match explicit_pid {
        Some(pid) => format!("pid {pid} (given)"),
        None => match parent_process_id() {
            Some(pid) => format!("pid {pid} (parent)"),
            None => "unknown".to_string(),
        },
    };
    let image = explicit_pid
        .or_else(parent_process_id)
        .and_then(process_image_path)
        .unwrap_or_else(|| "(unresolved)".to_string());
    println!("host    : {source}");
    println!("image   : {image}");
    match host_main_window_for(explicit_pid) {
        Ok((window, title)) => {
            let raised = raise_window(window);
            let (rect, pid) = unsafe {
                use windows::Win32::Foundation::RECT;
                use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, GetWindowThreadProcessId};
                let mut rect = RECT::default();
                let _ = GetWindowRect(window, &mut rect);
                let mut pid = 0u32;
                GetWindowThreadProcessId(window, Some(&mut pid));
                (rect, pid)
            };
            println!("resolved: hwnd={:?} pid={pid}", window.0);
            println!("title   : {title}");
            println!(
                "bounds  : {},{} {}x{}",
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top
            );
            println!("raised  : {raised}");
        }
        Err(reason) => println!("failed  : {reason}"),
    }
}

/// Hide the selection toolbar and forget its rectangle.
#[tauri::command]
fn bubble_hide_toolbar(app: AppHandle) {
    if let Some(window) = app.get_webview_window("toolbar") {
        if window.is_visible().unwrap_or(false) {
            crate::log::line("toolbar: hidden by the page");
        }
        let _ = window.hide();
    }
    selection::set_toolbar_rect(None);
    selection::note_hidden();
}

/**
 * Guard against re-entrant toolbar reveals.
 *
 * Revealing a window pumps messages, so anything that emits during the reveal can call back into
 * here while the first call is still on the stack. Rendering the toolbar is idempotent for one
 * selection, so a nested call is simply dropped.
 */
static REVEALING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/**
 * Make the toolbar incapable of taking focus.
 *
 * `WS_EX_NOACTIVATE` is the whole fix for three symptoms that looked unrelated: the user's document
 * lost focus the moment the toolbar appeared, Windows ghosted the ball while the focus churn blocked
 * its message loop, and the selection poll asked *the toolbar* whether anything was still selected -
 * read nothing - and retired the toolbar the user had just summoned. A window with this style still
 * receives mouse clicks, and the toolbar has no text input that would need keyboard focus.
 *
 * @param app - Application handle owning the toolbar window.
 */
fn make_toolbar_non_activating(app: &AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    let Some(window) = app.get_webview_window("toolbar") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            style | WS_EX_NOACTIVATE.0 as isize,
        );
    }
    crate::log::line("toolbar: WS_EX_NOACTIVATE applied");
}

/**
 * Place the selection toolbar beside a physical point and reveal it.
 *
 * The toolbar window is sized in logical pixels, so the physical size is read back before the
 * clamp keeps it inside the monitor's work area.
 */
fn show_selection_toolbar(app: &AppHandle, payload: &selection::SelectionPayload) {
    if REVEALING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        crate::log::line("toolbar: re-entrant reveal dropped");
        return;
    }
    reveal_selection_toolbar(app, payload);
    REVEALING.store(false, std::sync::atomic::Ordering::SeqCst);
}

fn reveal_selection_toolbar(app: &AppHandle, payload: &selection::SelectionPayload) {
    let Some(window) = app.get_webview_window("toolbar") else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let width = size.width as i32;
    let height = size.height as i32;
    let (mut x, mut y) = (payload.x - width / 2, payload.y + 18);
    if let Ok(Some(monitor)) = app.monitor_from_point(payload.x as f64, payload.y as f64) {
        let area = monitor.work_area();
        let left = area.position.x;
        let top = area.position.y;
        let right = left + area.size.width as i32;
        let bottom = top + area.size.height as i32;
        if y + height > bottom {
            y = payload.y - height - 8;
        }
        x = x.clamp(left, (right - width).max(left));
        y = y.clamp(top, (bottom - height).max(top));
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
    selection::set_toolbar_rect(Some(selection::PhysicalRect {
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
    }));
    let _ = window.show();
    // A dedicated event name: `bubble:selection` is what the hook sends *to* this process's listener,
    // and re-emitting the same name from a listener that a reveal can pump again is exactly the
    // infinite recursion that used to overflow the main thread's stack.
    let _ = window.emit("bubble:selection-ready", payload.clone());
    selection::note_shown(&payload.text);
    crate::log::line(&format!("toolbar: shown at {x},{y} size {width}x{height}"));
}

/// Exit when the plugin host closes this process's stdin, so a crashed host cannot strand the ball.
fn watch_parent(handle: AppHandle) {
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buffer = [0u8; 256];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    crate::log::line("stdin closed; exiting");
                    handle.exit(0);
                    return;
                }
                Ok(_) => {}
            }
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let selection_enabled = env_or("BUBBLE_SELECTION_TOOLBAR", "1") != "0";
    let selection = CheckMenuItem::with_id(
        app,
        "selection",
        "划词工具条",
        true,
        selection_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出悬浮球", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&selection, &quit])?;
    let selection_item = selection.clone();
    TrayIconBuilder::with_id("bubble-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("DSH Bubble")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "selection" => {
                let enabled = selection_item.is_checked().unwrap_or(true);
                selection::set_enabled(enabled);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    // Offline diagnostic: report which window the focus button would raise, then exit without
    // touching the UI. Lets the resolution be verified without a running DSH and without clicking.
    // `--focus-main-check=<pid>` checks against an explicit host process, for runs started by hand.
    if let Some(argument) = std::env::args().find(|value| value.starts_with("--focus-main-check")) {
        let explicit = argument
            .split_once('=')
            .and_then(|(_, value)| value.trim().parse::<u32>().ok());
        focus_main_check(explicit);
        return;
    }
    install_crash_log();
    install_exception_log();
    crate::log::line(&format!("start pid={}", std::process::id()));
    tauri::Builder::default()
        .manage(Mutex::new(BubbleState::placeholder()))
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            crate::log::line("second instance rejected");
            if let Some(window) = app.get_webview_window("ball") {
                let _ = window.show();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            bubble_state,
            bubble_environment,
            bubble_set_expanded,
            bubble_move_ball,
            bubble_clamp,
            bubble_unsnap,
            bubble_hide,
            bubble_quit,
            bubble_open_url,
            bubble_hide_toolbar,
            bubble_focus_main,
            bubble_flash_main,
            bubble_panel_ready,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let window = app
                .get_webview_window("ball")
                .expect("ball window is declared in tauri.conf.json");
            {
                let managed = app.state::<Mutex<BubbleState>>();
                let mut state = managed.lock().unwrap();
                ensure_placed(&handle, &mut state);
                place_collapsed(&window, &state);
            }
            crate::log::line("setup: ball placed");
            make_toolbar_non_activating(&handle);
            window.show()?;
            build_tray(&handle)?;
            watch_parent(handle.clone());
            let selection_handle = handle.clone();
            handle.listen("bubble:selection", move |event| {
                let Ok(payload) =
                    serde_json::from_str::<selection::SelectionPayload>(event.payload())
                else {
                    return;
                };
                // Showing a window from inside an event listener re-enters the message pump while
                // the emit is still on the stack. Defer it so the listener returns first.
                let app = selection_handle.clone();
                let _ = selection_handle
                    .run_on_main_thread(move || show_selection_toolbar(&app, &payload));
            });
            // The global mouse hook is opt-out: a deployment that dislikes it disables the
            // toolbar in the plugin config and the hook is never installed.
            if env_or("BUBBLE_SELECTION_TOOLBAR", "1") != "0" {
                selection::start(handle.clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the DSH Bubble desktop shell");
}

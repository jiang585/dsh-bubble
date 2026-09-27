//! Global selection monitor: a low-level mouse hook plus UI Automation text reads.
//!
//! A left-button drag ends in a UI Automation read of the focused element's text selection. The
//! clipboard route is deliberately not used: sending Ctrl+C would interrupt a running command in a
//! console window, and UI Automation has no such side effect. A read that yields nothing simply
//! shows no toolbar.
//!
//! The hook procedure must return immediately, so it only forwards coordinates over a channel; the
//! message pump on the same thread drains them, and a separate worker owns the COM apartment.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter};
use windows::core::{implement, BSTR, Result as WinResult};
use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationFocusChangedEventHandler,
    IUIAutomationFocusChangedEventHandler_Impl, IUIAutomationTextPattern, UIA_TextPatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW,
    GetWindowThreadProcessId, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    MSLLHOOKSTRUCT, MSG, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP,
};

/** Shortest drag, in physical pixels, that counts as a selection gesture. */
const DRAG_THRESHOLD: i32 = 8;

/** Longest selection forwarded to the toolbar, in characters. */
const SELECTION_LIMIT: usize = 4000;

/** A second press ending within this window, near the first, is a double-click word selection. */
const DOUBLE_CLICK_MS: u128 = 500;

/** How far the second click of a double-click may drift, in physical pixels. */
const DOUBLE_CLICK_SLOP: i32 = 6;

/** How often a visible toolbar re-checks that something is still selected. */
const SELECTION_POLL_MS: u64 = 300;

/** Coordinates the hook forwards to the pump thread. */
enum HookMessage {
    Down(POINT),
    Up(POINT),
}

/** A queued UI Automation read, tagged with the generation that requested it. */
struct SelectionRequest {
    /// Where the drag ended, in physical pixels.
    point: POINT,
    /// Value of {@link EPOCH} when the drag ended.
    epoch: u64,
}

/** Bounded queue depth between the hook procedure and its dispatcher. */
const HOOK_QUEUE: usize = 512;

/**
 * Generation of the newest selection gesture.
 *
 * A UI Automation read is slow and asynchronous: by the time it returns, the user may have
 * dismissed the toolbar or started another selection. Every read carries the generation it was
 * requested in and a result from an older generation is dropped, so the toolbar can never
 * resurrect itself after a dismissal.
 */
static EPOCH: AtomicU64 = AtomicU64::new(0);

/**
 * Whether the monitor reacts to mouse events.
 *
 * The hook stays installed so the tray switch takes effect immediately; a disabled monitor does one
 * atomic load and returns.
 */
static ENABLED: AtomicBool = AtomicBool::new(true);

/**
 * Turn the selection monitor on or off without reinstalling the hook.
 * @param enabled - Whether a drag should be read as a selection.
 */
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    if !enabled {
        set_toolbar_rect(None);
        EPOCH.fetch_add(1, Ordering::Relaxed);
    }
}

/** Channel the hook procedure writes to; set once per process. */
static HOOK_TX: OnceLock<SyncSender<HookMessage>> = OnceLock::new();

/** Physical rectangle of the toolbar window, so a click on it does not dismiss it. */
static TOOLBAR_RECT: Mutex<Option<PhysicalRect>> = Mutex::new(None);

/**
 * Text the visible toolbar was built from, or `None` while no toolbar is up.
 *
 * The toolbar's lifetime follows the selection: while this is `Some`, a background poll keeps asking
 * UI Automation whether anything is still selected and retires the toolbar the moment the selection
 * is gone - however it was cleared (click, Escape, focus change, another app).
 */
static TOOLBAR_TEXT: Mutex<Option<String>> = Mutex::new(None);

/**
 * Record that the toolbar is now showing `text`.
 * @param text - Selection the toolbar was built from.
 */
pub fn note_shown(text: &str) {
    if let Ok(mut guard) = TOOLBAR_TEXT.lock() {
        *guard = Some(text.to_string());
    }
}

/** Record that the toolbar is gone. */
pub fn note_hidden() {
    if let Ok(mut guard) = TOOLBAR_TEXT.lock() {
        *guard = None;
    }
}

/** Whether a toolbar is currently up. */
fn toolbar_shown() -> bool {
    TOOLBAR_TEXT
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

/** Physical screen rectangle, in the hook's coordinate space. */
#[derive(Clone, Copy)]
pub struct PhysicalRect {
    /// Left edge.
    pub left: i32,
    /// Top edge.
    pub top: i32,
    /// Right edge, exclusive.
    pub right: i32,
    /// Bottom edge, exclusive.
    pub bottom: i32,
}

/**
 * Record the toolbar's physical rectangle.
 * @param rect - Current toolbar bounds, or `None` once it is hidden.
 */
pub fn set_toolbar_rect(rect: Option<PhysicalRect>) {
    if let Ok(mut guard) = TOOLBAR_RECT.lock() {
        *guard = rect;
    }
}

/** Whether a physical point lands on the toolbar window (with margin for hit testing tolerance). */
fn inside_toolbar(point: POINT) -> bool {
    let Ok(guard) = TOOLBAR_RECT.lock() else {
        return false;
    };
    match *guard {
        Some(rect) => {
            const MARGIN: i32 = 14;
            point.x >= (rect.left - MARGIN)
                && point.x <= (rect.right + MARGIN)
                && point.y >= (rect.top - MARGIN)
                && point.y <= (rect.bottom + MARGIN)
        }
        None => false,
    }
}

/** Whether the foreground window belongs to this process. */
fn foreground_is_ours() -> bool {
    unsafe {
        let window = GetForegroundWindow();
        if window.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        pid == std::process::id()
    }
}

/** The low-level mouse hook: forward the event and never block. */
unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && ENABLED.load(Ordering::Relaxed) {
        if let Some(tx) = HOOK_TX.get() {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let message = match wparam.0 as u32 {
                WM_LBUTTONDOWN => Some(HookMessage::Down(info.pt)),
                WM_LBUTTONUP => Some(HookMessage::Up(info.pt)),
                // Nothing else retires the toolbar. Right clicks (the copy path), keys, and the
                // wheel are all left alone on purpose: trackpads emit wheel bursts while scrolling,
                // and a toolbar that vanishes under the user is worse than one they dismiss with a
                // click.
                _ => None,
            };
            if let Some(message) = message {
                // Never block the hook thread; the dispatcher drains this channel.
                let _ = tx.try_send(message);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/**
 * Make this process look like an assistive client.
 *
 * Chromium - and therefore the DSH window itself, every Electron app, and most browsers - only
 * builds its UI Automation text provider once `UiaClientsAreListening()` reports true, which flips
 * as soon as any client registers an event handler. Registering a no-op focus listener is the
 * cheapest honest way to say "a client is here"; without it those windows answer every read with
 * nothing at all.
 *
 * The handler must live in its own single-threaded apartment with a message pump, so it gets a
 * dedicated thread and never shares the worker's apartment.
 */
fn start_assistive_listener() {
    std::thread::spawn(|| unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return;
        }
        let automation: IUIAutomation =
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(automation) => automation,
                Err(_) => return,
            };
        let listener: IUIAutomationFocusChangedEventHandler = FocusListener.into();
        if automation
            .AddFocusChangedEventHandler(None, &listener)
            .is_err()
        {
            return;
        }
        crate::log::line("selection: assistive listener registered");
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    });
}

/** A focus listener that only exists so on-demand providers switch themselves on. */
#[implement(IUIAutomationFocusChangedEventHandler)]
struct FocusListener;

impl IUIAutomationFocusChangedEventHandler_Impl for FocusListener_Impl {
    fn HandleFocusChangedEvent(
        &self,
        _sender: windows::core::Ref<'_, IUIAutomationElement>,
    ) -> WinResult<()> {
        Ok(())
    }
}

/**
 * Start the selection monitor.
 *
 * The hook lives on a thread that blocks in `GetMessageW`: Windows delivers a low-level hook
 * callback by posting to the thread that installed it, so any sleep or blocking receive on that
 * thread delays every mouse event and eventually makes Windows drop the hook. All handling
 * therefore happens on a second thread fed by a non-blocking channel.
 *
 * @param app - Application handle used to publish selection events.
 */
pub fn start(app: AppHandle) {
    let (hook_tx, hook_rx) = sync_channel::<HookMessage>(HOOK_QUEUE);
    if HOOK_TX.set(hook_tx).is_err() {
        return;
    }

    let dispatcher_app = app.clone();
    std::thread::spawn(move || dispatch(dispatcher_app, hook_rx));

    start_assistive_listener();

    // The hook thread only pumps messages; it never touches shared state beyond the channel send.
    std::thread::spawn(move || unsafe {
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
            Ok(hook) => hook,
            Err(error) => {
                let _ = app.emit("bubble:selection-error", format!("{error}"));
                return;
            }
        };
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = UnhookWindowsHookEx(hook);
    });
}

/** Turn hook messages into toolbar shows and dismissals. */
fn dispatch(app: AppHandle, rx: Receiver<HookMessage>) {
    let (work_tx, work_rx) = sync_channel::<SelectionRequest>(8);
    let worker_app = app.clone();
    std::thread::spawn(move || automation_worker(worker_app, work_rx));

    let mut pressed: Option<POINT> = None;
    let mut last_up: Option<(POINT, std::time::Instant)> = None;
    while let Ok(message) = rx.recv() {
        match message {
            HookMessage::Down(point) => {
                pressed = Some(point);
                // A press outside the toolbar retires it. Pressing a toolbar button must not, so the
                // hit test carries a margin.
                if !inside_toolbar(point) {
                    EPOCH.fetch_add(1, Ordering::Relaxed);
                    note_hidden();
                    crate::log::line(&format!("selection: press outside at {},{} -> dismiss", point.x, point.y));
                    let _ = app.emit_to("toolbar", "bubble:dismiss", ());
                }
            }
            HookMessage::Up(point) => {
                let start = pressed.take();
                let dragged = start.is_some_and(|start| {
                    (point.x - start.x).abs() >= DRAG_THRESHOLD
                        || (point.y - start.y).abs() >= DRAG_THRESHOLD
                });
                // A double-click selects a word without any drag, and that is a selection too.
                let double_click = last_up.is_some_and(|(previous, at)| {
                    at.elapsed().as_millis() <= DOUBLE_CLICK_MS
                        && (point.x - previous.x).abs() <= DOUBLE_CLICK_SLOP
                        && (point.y - previous.y).abs() <= DOUBLE_CLICK_SLOP
                });
                last_up = Some((point, std::time::Instant::now()));
                if (dragged || double_click) && !foreground_is_ours() {
                    // Tag the read with a fresh generation so a newer gesture (or a dismissal)
                    // invalidates it while it is still being computed.
                    let epoch = EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
                    crate::log::line(&format!(
                        "selection: {} ended at {},{} epoch={epoch}",
                        if dragged { "drag" } else { "double click" },
                        point.x,
                        point.y
                    ));
                    let _ = work_tx.try_send(SelectionRequest { point, epoch });
                }
            }
        }
    }
}

/** Own one COM apartment and answer selection reads. */
fn automation_worker(app: AppHandle, rx: Receiver<SelectionRequest>) {
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return;
        }
        let automation: IUIAutomation =
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(automation) => automation,
                Err(error) => {
                    let _ = app.emit("bubble:selection-error", format!("{error}"));
                    return;
                }
            };
        loop {
            let request = match rx.recv_timeout(std::time::Duration::from_millis(SELECTION_POLL_MS))
            {
                Ok(request) => request,
                Err(RecvTimeoutError::Timeout) => {
                    poll_selection_gone(&app, &automation);
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let started = std::time::Instant::now();
            let Some(text) = read_selection(&automation) else {
                crate::log::line(&format!(
                    "selection: read empty in {}ms",
                    started.elapsed().as_millis()
                ));
                continue;
            };
            // A read that finished after the toolbar was dismissed or after a newer gesture must not
            // bring the toolbar back.
            if EPOCH.load(Ordering::Relaxed) != request.epoch {
                crate::log::line(&format!(
                    "selection: dropped stale read ({}ms, epoch {})",
                    started.elapsed().as_millis(),
                    request.epoch
                ));
                continue;
            }
            crate::log::line(&format!(
                "selection: showing toolbar for {} chars at {},{} ({}ms)",
                text.chars().count(),
                request.point.x,
                request.point.y,
                started.elapsed().as_millis()
            ));
            note_shown(&text);
            // The shell positions and reveals the toolbar before forwarding the text to it.
            let _ = app.emit(
                "bubble:selection",
                SelectionPayload {
                    text,
                    x: request.point.x,
                    y: request.point.y,
                },
            );
        }
    }
}

/** One selected text plus the physical point where the drag ended. */
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SelectionPayload {
    /// Selected text, trimmed and length-capped.
    pub text: String,
    /// Physical x of the drag end.
    pub x: i32,
    /// Physical y of the drag end.
    pub y: i32,
}

/**
 * Retire a visible toolbar once nothing is selected any more.
 *
 * This is what makes the toolbar follow the selection instead of a timer: clearing the selection by
 * any means - clicking, Escape, switching apps, collapsing the range - takes the toolbar with it.
 *
 * @param app - Application handle used to publish the dismissal.
 * @param automation - Automation client owned by this thread.
 */
unsafe fn poll_selection_gone(app: &AppHandle, automation: &IUIAutomation) {
    if !toolbar_shown() {
        return;
    }
    // While one of our own windows owns the foreground, "the focused element has no selection" says
    // nothing about the user's document: the question is being asked of the wrong window. Keep the
    // toolbar and let an explicit click retire it.
    if foreground_is_ours() {
        return;
    }
    if read_selection(automation).is_some() {
        return;
    }
    note_hidden();
    EPOCH.fetch_add(1, Ordering::Relaxed);
    crate::log::line("selection: selection cleared -> dismiss");
    let _ = app.emit_to("toolbar", "bubble:dismiss", ());
}

/** Read the focused element's selected text through UI Automation. */
unsafe fn read_selection(automation: &IUIAutomation) -> Option<String> {
    let element = automation.GetFocusedElement().ok()?;
    let pattern: IUIAutomationTextPattern = element.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
    let ranges = pattern.GetSelection().ok()?;
    let count = ranges.Length().ok()?;
    let mut text = String::new();
    for index in 0..count {
        let Ok(range) = ranges.GetElement(index) else {
            continue;
        };
        let Ok(value): Result<BSTR, _> = range.GetText(-1) else {
            continue;
        };
        text.push_str(&value.to_string());
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.chars().count() <= SELECTION_LIMIT {
        trimmed.to_string()
    } else {
        trimmed.chars().take(SELECTION_LIMIT).collect()
    })
}

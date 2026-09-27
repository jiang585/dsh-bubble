//! Floating-ball window geometry.
//!
//! Ported from the DeepSeek Orb desktop shell (`apps/desktop/src/floating-window.ts`) so the
//! Tauri shell reproduces the same collapsed ball, expanded panel, and edge-dock placement.
//! All values are physical pixels; the caller converts from and to Tauri physical coordinates.

use serde::{Deserialize, Serialize};

/// Painted ball diameter in CSS pixels.
pub const BALL_SIZE: i32 = 72;
/// Expanded panel size in CSS pixels.
pub const PANEL_WIDTH: i32 = 320;
/// Expanded panel size in CSS pixels.
pub const PANEL_HEIGHT: i32 = 420;
/// Transparent padding around the ball and panel so CSS shadows and the pin stroke are not clipped.
pub const CHROME_INSET: i32 = 12;
/// Collapsed window size including [`CHROME_INSET`].
pub const BALL_WINDOW_SIZE: i32 = BALL_SIZE + 2 * CHROME_INSET;
/// Expanded window size including [`CHROME_INSET`].
pub const PANEL_WINDOW_WIDTH: i32 = PANEL_WIDTH + 2 * CHROME_INSET;
/// Expanded window size including [`CHROME_INSET`].
pub const PANEL_WINDOW_HEIGHT: i32 = PANEL_HEIGHT + 2 * CHROME_INSET;
/// Downward offset from work-area vertical center, as a fraction of work-area height.
pub const BALL_DEFAULT_BELOW_CENTER: f64 = 0.08;
/// Ball width that must sit past a left or right display edge before pointer-up docks.
pub const DOCK_OVERLAP: i32 = BALL_SIZE / 5;
/// Painted dock-tab width.
pub const DOCK_TAB_WIDTH: i32 = 6;
/// Painted dock-tab height.
pub const DOCK_TAB_HEIGHT: i32 = BALL_SIZE;
/// Glow ring around the painted dock tab.
pub const DOCK_GLOW: i32 = 8;
/// Extra hover margin that keeps a docked tab reachable.
pub const DOCK_HOVER_MARGIN: i32 = 20;
/// Docked window width: the tab plus its glow and hover margin.
pub const DOCK_HIT_WIDTH: i32 = DOCK_TAB_WIDTH + DOCK_GLOW + DOCK_HOVER_MARGIN;
/// Docked window height: the tab plus its glow.
pub const DOCK_HIT_HEIGHT: i32 = DOCK_TAB_HEIGHT + 2 * DOCK_GLOW;
/// Gap past the display edge when the ball slides fully off before the tab appears.
pub const DOCK_OFF_GAP: i32 = 2;
/// Inset from the display edge after unsnap.
pub const DOCK_IN_PAD: i32 = 5;
/// Pointer distance from a docked edge that pulls the tab back into a ball.
pub const DOCK_DRAG_OFF: i32 = BALL_SIZE / 3;

/// A point in physical screen coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    /// Horizontal coordinate.
    pub x: i32,
    /// Vertical coordinate.
    pub y: i32,
}

/// A rectangle in physical screen coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    /// Left edge.
    pub x: i32,
    /// Top edge.
    pub y: i32,
    /// Width in pixels.
    pub width: i32,
    /// Height in pixels.
    pub height: i32,
}

/// Horizontal panel growth relative to the ball origin.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Horizontal {
    /// The panel grows to the left of the ball.
    Left,
    /// The panel grows to the right of the ball.
    Right,
}

/// Vertical panel growth relative to the ball origin.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Vertical {
    /// The panel grows above the ball.
    Up,
    /// The panel grows below the ball.
    Down,
}

/// Panel growth used by one expand or collapse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Direction {
    /// Horizontal growth.
    pub horizontal: Horizontal,
    /// Vertical growth.
    pub vertical: Vertical,
}

/// Edge a collapsed ball docks to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DockSide {
    /// Left display edge.
    Left,
    /// Right display edge.
    Right,
}

/// Clamp one value into an inclusive range.
fn clamp(value: i32, low: i32, high: i32) -> i32 {
    value.max(low).min(high)
}

/// Clamp a ball origin inside a work area.
pub fn clamped_ball_origin(ball: Point, work_area: Rect) -> Point {
    Point {
        x: clamp(
            ball.x,
            work_area.x,
            work_area.x + work_area.width - BALL_SIZE,
        ),
        y: clamp(
            ball.y,
            work_area.y,
            work_area.y + work_area.height - BALL_SIZE,
        ),
    }
}

/// Collapsed-ball origin on a work-area right edge, slightly below vertical center.
pub fn default_ball_origin(work_area: Rect) -> Point {
    let x = work_area.x + work_area.width - BALL_SIZE;
    let center_y = work_area.y + (work_area.height - BALL_SIZE) / 2;
    let y = center_y + (work_area.height as f64 * BALL_DEFAULT_BELOW_CENTER) as i32;
    clamped_ball_origin(Point { x, y }, work_area)
}

/// Choose panel growth so the expanded overlay stays on the side of the ball with free space.
pub fn expand_direction(ball: Point, work_area: Rect) -> Direction {
    let center_x = ball.x + BALL_SIZE / 2;
    let horizontal = if center_x - work_area.x > work_area.width / 2 {
        Horizontal::Left
    } else {
        Horizontal::Right
    };
    let vertical = if ball.y - work_area.y < PANEL_HEIGHT - BALL_SIZE {
        Vertical::Down
    } else {
        Vertical::Up
    };
    Direction {
        horizontal,
        vertical,
    }
}

/// Collapsed window rectangle for a ball origin.
pub fn collapsed_window_rect(ball: Point) -> Rect {
    Rect {
        x: ball.x - CHROME_INSET,
        y: ball.y - CHROME_INSET,
        width: BALL_WINDOW_SIZE,
        height: BALL_WINDOW_SIZE,
    }
}

/// Expanded overlay rectangle that keeps the ball origin in its growth corner.
pub fn overlay_bounds_from_ball(ball: Point, direction: Direction) -> Rect {
    let x = match direction.horizontal {
        Horizontal::Left => ball.x - (PANEL_WIDTH - BALL_SIZE) - CHROME_INSET,
        Horizontal::Right => ball.x - CHROME_INSET,
    };
    let y = match direction.vertical {
        Vertical::Up => ball.y - (PANEL_HEIGHT - BALL_SIZE) - CHROME_INSET,
        Vertical::Down => ball.y - CHROME_INSET,
    };
    Rect {
        x,
        y,
        width: PANEL_WINDOW_WIDTH,
        height: PANEL_WINDOW_HEIGHT,
    }
}

/// Keep a window origin inside a work area.
fn clamp_window_origin(origin: i32, work_start: i32, work_size: i32, window_size: i32) -> i32 {
    clamp(origin, work_start, work_start + work_size - window_size)
}

/// Expanded overlay bounds clamped into the work area, plus the growth used.
pub fn expanded_overlay_bounds(ball: Point, work_area: Rect) -> (Rect, Direction) {
    let direction = expand_direction(ball, work_area);
    let raw = overlay_bounds_from_ball(ball, direction);
    let bounds = Rect {
        x: clamp_window_origin(raw.x, work_area.x, work_area.width, raw.width),
        y: clamp_window_origin(raw.y, work_area.y, work_area.height, raw.height),
        width: raw.width,
        height: raw.height,
    };
    (bounds, direction)
}

/// Ball origin inside an expanded overlay for a stored growth direction.
pub fn ball_origin_from_window(bounds: Rect, direction: Direction) -> Point {
    Point {
        x: match direction.horizontal {
            Horizontal::Left => bounds.x + bounds.width - CHROME_INSET - BALL_SIZE,
            Horizontal::Right => bounds.x + CHROME_INSET,
        },
        y: match direction.vertical {
            Vertical::Up => bounds.y + bounds.height - CHROME_INSET - BALL_SIZE,
            Vertical::Down => bounds.y + CHROME_INSET,
        },
    }
}

/// Dock side for a pointer-up ball origin, or `None` when the ball is only flush with an edge.
pub fn dock_side_for_ball_origin(ball: Point, work_area: Rect) -> Option<DockSide> {
    if ball.x + BALL_SIZE - work_area.x <= DOCK_OVERLAP {
        return Some(DockSide::Left);
    }
    if work_area.x + work_area.width - ball.x <= DOCK_OVERLAP {
        return Some(DockSide::Right);
    }
    None
}

/// Docked window rectangle for a dock side and the ball origin's vertical position.
pub fn docked_window_rect(side: DockSide, ball_y: i32, work_area: Rect) -> Rect {
    let x = match side {
        DockSide::Left => work_area.x,
        DockSide::Right => work_area.x + work_area.width - DOCK_HIT_WIDTH,
    };
    let centered = ball_y + BALL_SIZE / 2 - DOCK_HIT_HEIGHT / 2;
    let y = clamp(
        centered,
        work_area.y,
        work_area.y + work_area.height - DOCK_HIT_HEIGHT,
    );
    Rect {
        x,
        y,
        width: DOCK_HIT_WIDTH,
        height: DOCK_HIT_HEIGHT,
    }
}

/// Ball origin with the ball slid fully past a display edge behind the tab.
pub fn off_screen_ball_origin(side: DockSide, ball_y: i32, work_area: Rect) -> Point {
    let x = match side {
        DockSide::Left => work_area.x - BALL_SIZE - DOCK_OFF_GAP,
        DockSide::Right => work_area.x + work_area.width + DOCK_OFF_GAP,
    };
    Point { x, y: ball_y }
}

/// Ball origin after unsnap: fully visible with [`DOCK_IN_PAD`] from the same edge.
pub fn inside_ball_origin(side: DockSide, ball_y: i32, work_area: Rect) -> Point {
    let x = match side {
        DockSide::Left => work_area.x + DOCK_IN_PAD,
        DockSide::Right => work_area.x + work_area.width - BALL_SIZE - DOCK_IN_PAD,
    };
    clamped_ball_origin(Point { x, y: ball_y }, work_area)
}

/// Whether a dragged docked tab stays docked at this ball origin.
pub fn stays_docked(side: DockSide, ball_x: i32, work_area: Rect) -> bool {
    match side {
        DockSide::Left => ball_x <= work_area.x + DOCK_DRAG_OFF,
        DockSide::Right => ball_x >= work_area.x + work_area.width - BALL_SIZE - DOCK_DRAG_OFF,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work_area() -> Rect {
        Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        }
    }

    #[test]
    fn collapsed_window_is_ball_plus_chrome() {
        let rect = collapsed_window_rect(Point { x: 500, y: 400 });
        assert_eq!(rect.width, 96);
        assert_eq!(rect.height, 96);
        assert_eq!(rect.x, 488);
        assert_eq!(rect.y, 388);
    }

    #[test]
    fn default_origin_sits_on_the_right_edge_below_center() {
        let origin = default_ball_origin(work_area());
        assert_eq!(origin.x, 1920 - 72);
        assert_eq!(origin.y, (1040 - 72) / 2 + (1040.0 * 0.08) as i32);
    }

    #[test]
    fn panel_grows_left_and_up_near_the_bottom_right_corner() {
        let ball = Point { x: 1848, y: 900 };
        let (bounds, direction) = expanded_overlay_bounds(ball, work_area());
        assert_eq!(direction.horizontal, Horizontal::Left);
        assert_eq!(direction.vertical, Vertical::Up);
        assert_eq!(bounds.width, 344);
        assert_eq!(bounds.height, 444);
        let restored = ball_origin_from_window(bounds, direction);
        assert_eq!(restored, ball);
    }

    #[test]
    fn panel_grows_right_and_down_near_the_top_left_corner() {
        let ball = Point { x: 40, y: 40 };
        let (bounds, direction) = expanded_overlay_bounds(ball, work_area());
        assert_eq!(direction.horizontal, Horizontal::Right);
        assert_eq!(direction.vertical, Vertical::Down);
        assert_eq!(bounds.x, ball.x - CHROME_INSET);
        assert_eq!(bounds.y, ball.y - CHROME_INSET);
        assert_eq!(ball_origin_from_window(bounds, direction), ball);
    }

    #[test]
    fn clamp_keeps_the_ball_inside_the_work_area() {
        let clamped = clamped_ball_origin(Point { x: -50, y: 5000 }, work_area());
        assert_eq!(clamped.x, 0);
        assert_eq!(clamped.y, 1040 - 72);
    }

    #[test]
    fn a_flush_ball_does_not_dock() {
        assert_eq!(
            dock_side_for_ball_origin(Point { x: 0, y: 500 }, work_area()),
            None
        );
        assert_eq!(
            dock_side_for_ball_origin(Point { x: 1920 - 72, y: 500 }, work_area()),
            None
        );
    }

    #[test]
    fn a_ball_past_the_edge_docks() {
        assert_eq!(
            dock_side_for_ball_origin(Point { x: -10, y: 500 }, work_area()),
            Some(DockSide::Left)
        );
        assert_eq!(
            dock_side_for_ball_origin(Point { x: 1915, y: 500 }, work_area()),
            Some(DockSide::Right)
        );
    }

    #[test]
    fn docked_tab_centers_on_the_ball_and_unsnaps_inside() {
        let side = DockSide::Right;
        let tab = docked_window_rect(side, 500, work_area());
        assert_eq!(tab.width, DOCK_HIT_WIDTH);
        assert_eq!(tab.height, DOCK_HIT_HEIGHT);
        assert_eq!(tab.x, 1920 - DOCK_HIT_WIDTH);
        assert_eq!(tab.y, 500 + 36 - 44);
        let inside = inside_ball_origin(side, 500, work_area());
        assert_eq!(inside.x, 1920 - 72 - DOCK_IN_PAD);
        let off = off_screen_ball_origin(side, 500, work_area());
        assert_eq!(off.x, 1920 + DOCK_OFF_GAP);
    }

    #[test]
    fn drag_off_uses_the_stored_side() {
        assert!(stays_docked(DockSide::Left, 10, work_area()));
        assert!(!stays_docked(DockSide::Left, 40, work_area()));
        assert!(stays_docked(DockSide::Right, 1920 - 72 - 10, work_area()));
        assert!(!stays_docked(DockSide::Right, 1800, work_area()));
    }
}

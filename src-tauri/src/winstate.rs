//! The main window comes back where it was quit: monitor, position and
//! size. Saved in macOS logical points, which are one space across every
//! monitor; physical pixels aren't (tauri-plugin-window-state restored a
//! 1× monitor's physical position through the 2× screen's scale, and the
//! window came back elsewhere at half the size).
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window};
use tracing::{info, warn};

/// the last place seen (moves and resizes): at Exit the window may be gone
static LAST: Mutex<Option<Saved>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Saved {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// what both window handles can tell about their place: the frame's
/// top-left and the content size (what a window is built with)
trait Geo {
    fn geo(&self) -> Option<(f64, PhysicalPosition<i32>, PhysicalSize<u32>, bool)>;
}
impl Geo for Window {
    fn geo(&self) -> Option<(f64, PhysicalPosition<i32>, PhysicalSize<u32>, bool)> {
        Some((self.scale_factor().ok()?, self.outer_position().ok()?, self.inner_size().ok()?, self.is_minimized().unwrap_or(false)))
    }
}
impl Geo for WebviewWindow {
    fn geo(&self) -> Option<(f64, PhysicalPosition<i32>, PhysicalSize<u32>, bool)> {
        Some((self.scale_factor().ok()?, self.outer_position().ok()?, self.inner_size().ok()?, self.is_minimized().unwrap_or(false)))
    }
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    crate::state::data_dir(app).ok().map(|d| d.join("window.json"))
}

/// Where the window is now, in logical points.
fn current(w: &impl Geo) -> Option<Saved> {
    let (scale, p, s, minimized) = w.geo()?;
    let p = p.to_logical::<f64>(scale);
    let s = s.to_logical::<f64>(scale);
    // (a minimized or not-yet-laid-out window reports nothing useful)
    if s.width < 200.0 || s.height < 150.0 || minimized {
        return None;
    }
    Some(Saved { x: p.x, y: p.y, w: s.width, h: s.height })
}

/// Note where the window is (on every move and resize).
pub fn note(w: &Window) {
    if let Some(cur) = current(w) {
        *LAST.lock().unwrap() = Some(cur);
    }
}

/// Where the window is, in logical points, or where it was last seen
pub fn place(app: &AppHandle) -> Option<Saved> {
    app.get_webview_window("main").and_then(|w| current(&w)).or_else(|| *LAST.lock().unwrap())
}

/// Remember the main window's place (on quit, and when it's closed).
pub fn save(app: &AppHandle) {
    let (Some(cur), Some(path)) = (place(app), file(app)) else {
        return warn!("window state not saved: no window and nothing seen");
    };
    let json = match serde_json::to_string_pretty(&cur) {
        Ok(j) => j,
        Err(e) => return warn!("window state not saved: {e}"),
    };
    match std::fs::write(&path, json) {
        Ok(()) => info!("window state saved: {cur:?}"),
        Err(e) => warn!("window state not saved: {e}"),
    }
}

/// The saved frame, when its spot is still on a monitor: the window is
/// built there (building it at the default spot and moving it showed a
/// flash on the main screen first).
pub fn saved_frame(app: &AppHandle) -> Option<Saved> {
    let path = file(app)?;
    let saved: Saved = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    if !(saved.w >= 200.0 && saved.h >= 150.0) {
        return None;
    }
    // on a monitor: the window's centre point, in the same logical space
    let (cx, cy) = (saved.x + saved.w / 2.0, saved.y + saved.h / 2.0);
    let on_screen = app.available_monitors().ok()?.iter().any(|m| {
        let s = m.scale_factor();
        let p = m.position().to_logical::<f64>(s);
        let z = m.size().to_logical::<f64>(s);
        cx >= p.x && cx < p.x + z.width && cy >= p.y && cy < p.y + z.height
    });
    if !on_screen {
        info!("window state: saved spot {saved:?} is on no monitor now; default placement");
        return None;
    }
    info!("window state restored: {saved:?}");
    Some(saved)
}

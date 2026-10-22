//! The macOS menu bar: the standard app / Edit / Window menus plus the
//! app's own File, View, Go and Help commands. A command item emits
//! "menu" with its id to the window, which runs the same action as its
//! keyboard shortcut (the webview handles a shortcut first and marks it
//! handled, so a key never fires twice).

use tauri::menu::{AboutMetadataBuilder, Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

/// Public repo's issue tracker (Help > Report an Issue…).
const ISSUES_URL: &str = "https://github.com/joshuayanggithub/northstar-calendar/issues";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let cmd = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(format!("app:{id}"), label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let info = app.package_info();
    let about = AboutMetadataBuilder::new()
        .name(Some(info.name.clone()))
        .version(Some(info.version.to_string()))
        .comments(Some("A calendar for doing the work: Google Calendar, two-way."))
        .build();

    let app_menu = SubmenuBuilder::new(app, "North Star")
        .about(Some(about))
        .separator()
        .item(&cmd("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&cmd("new-event", "New Event", Some("CmdOrCtrl+N"))?)
        .item(&cmd("quick-create", "Quick Create…", None)?)
        .separator()
        .item(&cmd("sync", "Sync with Google", Some("Shift+CmdOrCtrl+S"))?)
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&cmd("command-menu", "Command Menu…", Some("CmdOrCtrl+K"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&cmd("view-day", "Day", Some("CmdOrCtrl+1"))?)
        .item(&cmd("view-week", "Week", Some("CmdOrCtrl+2"))?)
        .item(&cmd("view-month", "Month", Some("CmdOrCtrl+3"))?)
        .item(&cmd("view-list", "List", Some("CmdOrCtrl+4"))?)
        .item(&cmd("view-insights", "Insights", Some("CmdOrCtrl+5"))?)
        .separator()
        .item(&cmd("weekends", "Show or Hide Weekends", Some("Shift+CmdOrCtrl+E"))?)
        .item(&cmd("sidebar", "Show or Hide Sidebar", Some("CmdOrCtrl+\\"))?)
        .item(&cmd("notes", "Show or Hide Notes", Some("Shift+CmdOrCtrl+M"))?)
        .separator()
        .item(&cmd("zoom-in", "Zoom In", Some("Shift+CmdOrCtrl+."))?)
        .item(&cmd("zoom-out", "Zoom Out", Some("Shift+CmdOrCtrl+,"))?)
        .item(&cmd("zoom-reset", "Actual Size", Some("Shift+CmdOrCtrl+0"))?)
        .separator()
        .fullscreen()
        .build()?;
    let go = SubmenuBuilder::new(app, "Go")
        .item(&cmd("today", "Today", Some("CmdOrCtrl+T"))?)
        .item(&cmd("prev", "Previous", Some("CmdOrCtrl+["))?)
        .item(&cmd("next", "Next", Some("CmdOrCtrl+]"))?)
        .item(&cmd("goto", "Go to Date…", Some("CmdOrCtrl+G"))?)
        .separator()
        .item(&cmd("join", "Join Next Meeting", Some("CmdOrCtrl+J"))?)
        .item(&cmd("reconcile", "Review Recent Events", None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&cmd("help", "North Star Help", None)?)
        .item(&cmd("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?)
        .separator()
        .item(&cmd("report", "Report an Issue…", None)?)
        .build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window, &help])
}

/// Menu clicks: the app's own commands go to the window; the tray's (and
/// anything else) are handled where they were built.
pub fn on_event(app: &AppHandle, id: &str) {
    let Some(cmd) = id.strip_prefix("app:") else { return };
    if cmd == "report" {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(ISSUES_URL, None::<&str>);
        return;
    }
    let _ = app.emit("menu", cmd);
}

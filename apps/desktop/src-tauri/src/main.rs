// Thin native shell. All intelligence lives in the Nova daemon (apps/daemon);
// this window just renders the glass UI and grants mic access.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Nova");
}

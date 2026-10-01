// A menu-bar application: no console window is ever wanted behind it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ndbrain_desktop::run();
}

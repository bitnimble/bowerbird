#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    std::process::exit(updater::main(std::env::args_os()));
}

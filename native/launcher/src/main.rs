//! The container's PID 1: `launcher --home <dir> --fallback <dir> -- <command...>`.
//!
//! Every `{payload}` in the command is replaced with the directory the version being run
//! lives in, and the command is started with that directory as its working directory - so
//! a server started as `bun run src/index.ts` resolves its own `node_modules` rather than
//! whichever version happened to be installed first.
//!
//! The desktop app needs no binary here: it is its own supervisor, calling
//! `launcher::supervise` from `src-tauri/src/main.rs` before it becomes an app.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(why) => {
            eprintln!("[bowerbird-launcher] {why}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<i32, String> {
    let mut home: Option<PathBuf> = None;
    let mut fallback: Option<PathBuf> = None;
    let mut command: Vec<OsString> = Vec::new();
    let mut arguments = std::env::args_os().skip(1);

    while let Some(argument) = arguments.next() {
        match argument.to_string_lossy().as_ref() {
            "--home" => home = arguments.next().map(PathBuf::from),
            "--fallback" => fallback = arguments.next().map(PathBuf::from),
            "--" => {
                command.extend(arguments);
                break;
            }
            _ => return Err(format!("unknown argument {}", argument.to_string_lossy())),
        }
    }

    let home = home.ok_or("no --home, so there is nowhere to keep the versions")?;
    let fallback = fallback.ok_or("no --fallback, so there is nothing to run before the first update")?;
    if command.is_empty() {
        return Err("no command after --, so there is nothing to start".into());
    }

    launcher::supervise(&home, &fallback, |payload| {
        let mut child = Command::new(substitute(&command[0], payload));
        for argument in &command[1..] {
            child.arg(substitute(argument, payload));
        }
        child.current_dir(payload);
        child
    })
}

fn substitute(argument: &OsString, payload: &Path) -> OsString {
    let text = argument.to_string_lossy();
    if !text.contains("{payload}") {
        return argument.clone();
    }
    OsString::from(text.replace("{payload}", &payload.to_string_lossy()))
}

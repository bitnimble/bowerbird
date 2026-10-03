use super::{Command, Error, Reply, run};
use serde_json::{Map, Value};

/// Runs one printing command, as `bb_run_job` runs a job: `command` is UTF-8 JSON
/// ([`Command`]), and the reply is UTF-8 JSON written into `out`, `{"ok":true,...}` with the
/// command's result or `{"ok":false,"error":"..."}`.
///
/// Returns the reply's length. Larger than `out_cap` means nothing was written and the caller
/// should ask again with a buffer that size, which runs the command again. Negative is a failure
/// that produced no reply at all.
///
/// Blocks on the OS and the network, so call it off the main thread.
///
/// # Safety
/// `command` must point at `command_len` readable bytes and `out` at `out_cap` writable ones, or
/// be null. Neither is retained.
#[expect(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_print_command(
    command: *const u8,
    command_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> isize {
    if command.is_null() {
        return -1;
    }
    // SAFETY: the caller promises `command_len` readable bytes, borrowed for this call only.
    let bytes = unsafe { std::slice::from_raw_parts(command, command_len) };
    let result = match serde_json::from_slice::<Command>(bytes) {
        Err(error) => Err(Error(format!("Can't read the print command: {error}"))),
        Ok(command) => guard(|| run(command)),
    };
    let payload = reply(result);
    if payload.len() > out_cap || out.is_null() {
        return payload.len() as isize;
    }
    // SAFETY: the caller promises `out_cap` writable bytes, and the payload is no longer.
    let destination = unsafe { std::slice::from_raw_parts_mut(out, payload.len()) };
    destination.copy_from_slice(&payload);
    payload.len() as isize
}

/// A panic crossing `extern "C"` aborts the whole server, so it comes back as a failed command.
fn guard(body: impl FnOnce() -> super::Result<Reply>) -> super::Result<Reply> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
        .unwrap_or_else(|_| Err(Error("Printing failed inside printshim".to_string())))
}

fn reply(result: super::Result<Reply>) -> Vec<u8> {
    let mut object = Map::new();
    match result {
        Ok(fields) => {
            object.insert("ok".into(), Value::Bool(true));
            object.extend(fields);
        }
        Err(Error(message)) => {
            object.insert("ok".into(), Value::Bool(false));
            object.insert("error".into(), Value::String(message));
        }
    }
    serde_json::to_vec(&Value::Object(object)).expect("a JSON value serialises")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(command: &str) -> String {
        let mut out = vec![0u8; 4096];
        #[expect(unsafe_code)]
        // SAFETY: both buffers are live and sized as passed.
        let written = unsafe {
            bb_print_command(command.as_ptr(), command.len(), out.as_mut_ptr(), out.len())
        };
        String::from_utf8(out[..written as usize].to_vec()).unwrap()
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn a_bad_command_is_a_json_error() {
        assert_eq!(
            json(&call(r#"{"kind":"capabilities","printer":"nowhere:x"}"#)),
            serde_json::json!({"ok": false, "error": "nowhere:x is not a printer on this system"})
        );
        let unknown = json(&call(r#"{"kind":"fly"}"#));
        assert_eq!(unknown["ok"], false);
        assert!(
            unknown["error"]
                .as_str()
                .unwrap()
                .starts_with("Can't read the print command: unknown variant `fly`")
        );
    }

    #[test]
    fn a_result_is_flattened_beside_ok() {
        let result = Ok(Reply::from_iter([("jobId".to_string(), Value::from(42))]));
        assert_eq!(
            serde_json::from_slice::<Value>(&reply(result)).unwrap(),
            serde_json::json!({"ok": true, "jobId": 42})
        );
    }

    #[test]
    fn a_panic_is_a_failed_command() {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let result = guard(|| panic!("as if a parse indexed past its end"));
        std::panic::set_hook(previous);
        assert_eq!(
            serde_json::from_slice::<Value>(&reply(result)).unwrap(),
            serde_json::json!({"ok": false, "error": "Printing failed inside printshim"})
        );
    }

    #[test]
    fn a_reply_too_big_for_the_buffer_reports_its_length_and_writes_nothing() {
        let command = r#"{"kind":"job","printer":"nowhere:x","jobId":1}"#;
        let mut out = [7u8; 4];
        #[expect(unsafe_code)]
        // SAFETY: both buffers are live and sized as passed.
        let needed = unsafe {
            bb_print_command(command.as_ptr(), command.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(needed as usize, call(command).len());
        assert_eq!(out, [7u8; 4]);
    }
}

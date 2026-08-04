//! The library's event stream, held here and re-emitted to the page.
//!
//! Every other call in this shell is request/response, which is why `api.rs` can converge
//! the two transports on HTTP's own shape. `/api/events` is the exception: it is Server-Sent
//! Events, a body that by design never ends, and `UriSchemeResponder` takes a whole
//! `Response<Vec<u8>>` - so answering it through the `bowerbird://` scheme means reading to
//! an end that never comes. That is what it used to do, and the page's `EventSource` sat in
//! `CONNECTING` for the life of the process without ever erroring.
//!
//! So the shell holds the stream instead and forwards each event over IPC. The page listens
//! rather than connecting, and the origin stays on this side, which is the property the
//! whole transport seam exists to keep.

use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Whether the stream is up, for a page that started listening after it came up.
///
/// A Tauri event reaches whoever is listening when it is emitted and is not replayed, and
/// this stream is the app's rather than the view's - it connects at startup, before the
/// webview has finished loading, and stays up across navigations. So a page that subscribes
/// later would never see an `open` and would never call `serverReachable`, where a browser's
/// `EventSource` gets one because the page owns the connection. It asks instead.
/// Which server, not merely whether: a connection to the library the reader has just left is
/// not one they can use, and reporting it as "connected" is how an address change looked
/// like it had worked when the stream had not moved at all.
static FOLLOWING: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn following(origin: Option<String>) {
    if let Ok(mut held) = FOLLOWING.lock() {
        *held = origin;
    }
}

/// Rung when the address moves, so the stream stops following the server it was told about
/// before.
///
/// Without it a change in Settings did nothing at all: the connection is only re-dialled
/// after the current one ends, and against a server that is still running it never does -
/// the heartbeat holds the socket open indefinitely. So the shell stayed on the old library,
/// `CONNECTED` stayed true, and the reloaded page was told the stream was up while every
/// event it was waiting for went to a server it had stopped reading from.
static MOVED: std::sync::OnceLock<std::sync::Arc<tokio::sync::Notify>> = std::sync::OnceLock::new();

fn moved() -> &'static std::sync::Arc<tokio::sync::Notify> {
    MOVED.get_or_init(|| std::sync::Arc::new(tokio::sync::Notify::new()))
}

/// Tells the stream its server has changed. Safe to call before it is following anything.
pub fn address_changed() {
    moved().notify_waiters();
}

/// The library the event stream is currently following, or null while it is not up.
#[tauri::command]
pub fn events_following() -> Option<String> {
    FOLLOWING.lock().ok().and_then(|held| held.clone())
}

/// The Tauri event the page listens on.
///
/// One channel for every kind of upstream event, with the kind as a field: a second event
/// type upstream should be a `match` in the page rather than a second listener here.
const CHANNEL: &str = "library:event";

/// Long enough that a server bouncing does not spin, short enough that a reader who fixed
/// the address in Settings sees the grid come back rather than wondering.
const FIRST_RETRY: Duration = Duration::from_secs(1);
const LONGEST_RETRY: Duration = Duration::from_secs(30);

/// What the page receives.
#[derive(Clone, serde::Serialize)]
struct Emitted {
    /// `open` when the stream connects, otherwise the SSE event's own name.
    kind: String,
    data: String,
}

/// Follows the library's events for as long as the app runs.
///
/// Never returns and never gives up: a stream that ends is a server that restarted or a
/// laptop that slept, both of which are reconnects rather than failures. `Last-Event-ID`
/// carries across them, so the events missed in between are replayed rather than lost -
/// which is the same guarantee the browser's own `EventSource` gives the web build.
pub fn follow(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_id: Option<String> = None;
        let mut wait = FIRST_RETRY;
        loop {
            // Reset on a stream that actually connected, so a server that drops one
            // connection an hour is not eventually waited on for thirty seconds.
            let held = stream(&app, &mut last_id).await;
            following(None);
            match held {
                // A move is not a failure and must not be waited out: the reader is looking
                // at the new library now. Its ids belong to the old server too, so asking to
                // resume from one would replay somebody else's events or nothing at all.
                Ok(Ended::Moved) => {
                    last_id = None;
                    wait = FIRST_RETRY;
                    continue;
                }
                Ok(Ended::Closed) => wait = FIRST_RETRY,
                // The only channel this has. A shell that cannot follow the library still
                // works for everything the reader does by hand - it just stops noticing what
                // the library does on its own - so this reports rather than gives up, and
                // saying so is the difference from the silence it replaced.
                Err(why) => eprintln!("[bowerbird] event stream: {why}; retrying in {wait:?}"),
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(LONGEST_RETRY);
        }
    });
}

/// Why a connection that was answered stopped.
enum Ended {
    /// The server closed it, or the process is going away.
    Closed,
    /// The reader pointed the app at a different library.
    Moved,
}

/// One connection, until it ends. `Ok` if it was answered before it did.
async fn stream(app: &AppHandle, last_id: &mut Option<String>) -> Result<Ended, String> {
    // Registered before the request, so an address that changes while this one is being
    // dialled is still noticed. `enable` is what does that: a `Notified` joins the waiter
    // list when it is first polled, and the first poll here is in the `select!` below -
    // after the connect - so without it a change inside that window wakes nobody and the
    // stream stays on the old server until that connection ends, which against a running
    // one is never. `notify_waiters` leaves no permit behind to catch it later.
    let moved = moved().clone();
    let moved = moved.notified();
    tokio::pin!(moved);
    moved.as_mut().enable();

    let origin = crate::api::origin();
    let url = format!("{origin}/api/events");
    let mut request = crate::api::client().get(&url).header("accept", "text/event-stream");
    if let Some(id) = last_id.as_deref() {
        request = request.header("last-event-id", id);
    }

    let mut reply = request.send().await.map_err(|e| format!("could not reach {url}: {e}"))?;
    if !reply.status().is_success() {
        return Err(format!("{url} answered {}", reply.status()));
    }
    // Before any event, and on every reconnect: the page treats it the way it treated
    // `EventSource`'s `open`, which is to re-ask for anything a request lost while the
    // server was away.
    following(Some(origin.clone()));
    let _ = app.emit(CHANNEL, Emitted { kind: "open".to_string(), data: String::new() });

    // `chunk` rather than `bytes_stream`, which would want reqwest's `stream` feature for a
    // loop this shape gets for nothing.
    let mut frames = Frames::default();
    loop {
        // The read is what has to be interrupted, not the retry: a live server's heartbeat
        // holds this open forever, so waiting for it to end is waiting for nothing.
        let chunk = tokio::select! {
            read = reply.chunk() => read.map_err(|e| format!("{url} stopped: {e}"))?,
            () = &mut moved => return Ok(Ended::Moved),
        };
        let Some(chunk) = chunk else { return Ok(Ended::Closed) };

        for frame in frames.push(&chunk) {
            if let Some(id) = frame.id {
                *last_id = Some(id);
            }
            let _ = app.emit(CHANNEL, Emitted { kind: frame.kind, data: frame.data });
        }
    }
}

struct Frame {
    kind: String,
    data: String,
    id: Option<String>,
}

/// An SSE event reassembled from however the chunks happened to land.
///
/// A chunk boundary falls wherever the network put it, so a field can arrive in two pieces
/// and an event can span several reads; what survives between calls is the part of a line
/// that has no terminator yet, and the fields of an event with no blank line yet.
///
/// Line endings are LF or CRLF. The spec allows a bare CR as well, which nothing this talks
/// to emits - Hono writes LF - and supporting it would mean holding a trailing CR back to
/// see whether an LF follows.
#[derive(Default)]
struct Frames {
    line: Vec<u8>,
    kind: Option<String>,
    data: Vec<String>,
    id: Option<String>,
}

impl Frames {
    fn push(&mut self, chunk: &[u8]) -> Vec<Frame> {
        let mut out = Vec::new();
        for byte in chunk {
            if *byte != b'\n' {
                self.line.push(*byte);
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            let line = String::from_utf8_lossy(&self.line).into_owned();
            self.line.clear();
            if let Some(frame) = self.line_read(&line) {
                out.push(frame);
            }
        }
        out
    }

    /// Returns an event where this line was the blank one that ends it.
    fn line_read(&mut self, line: &str) -> Option<Frame> {
        if line.is_empty() {
            return self.dispatch();
        }
        // A line opening with a colon is a comment. Servers send them to keep a connection
        // from idling out, which is what this one's heartbeat is for.
        if line.starts_with(':') {
            return None;
        }

        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.kind = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            "id" => self.id = Some(value.to_string()),
            // `retry` is the server's advice on reconnect delay, which this does not take:
            // the backoff above answers a server that is down, not one that closed tidily.
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<Frame> {
        let kind = self.kind.take();
        let id = self.id.clone();
        let data = std::mem::take(&mut self.data).join("\n");
        // An event with no data is not dispatched, which is what the spec says and what the
        // browser does - and is how the 20-second heartbeat stays out of the page.
        if data.is_empty() {
            return None;
        }
        Some(Frame { kind: kind.unwrap_or_else(|| "message".to_string()), data, id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(chunks: &[&str]) -> Vec<Frame> {
        let mut parser = Frames::default();
        chunks.iter().flat_map(|chunk| parser.push(chunk.as_bytes())).collect()
    }

    #[test]
    fn reads_an_event_the_library_sends() {
        let read = frames(&["id: 7\nevent: rendition\ndata: {\"id\":\"a\"}\n\n"]);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].kind, "rendition");
        assert_eq!(read[0].data, "{\"id\":\"a\"}");
        assert_eq!(read[0].id.as_deref(), Some("7"));
    }

    /// The reason this is a parser rather than a `split`: a chunk ends wherever the network
    /// put it, including the middle of a field name.
    #[test]
    fn reassembles_an_event_split_across_chunks() {
        let read = frames(&["id: 7\neve", "nt: rendi", "tion\ndata: {\"id\"", ":\"a\"}\n", "\n"]);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].kind, "rendition");
        assert_eq!(read[0].data, "{\"id\":\"a\"}");
    }

    #[test]
    fn reads_several_events_from_one_chunk() {
        let read = frames(&["event: rendition\ndata: one\n\nevent: rendition\ndata: two\n\n"]);
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].data, "one");
        assert_eq!(read[1].data, "two");
    }

    /// The heartbeat, which is what kept the socket alive and must not reach the page.
    #[test]
    fn drops_an_event_carrying_nothing() {
        assert!(frames(&["event: ping\ndata: \n\n"]).is_empty());
        assert!(frames(&[": keep alive\n\n"]).is_empty());
    }

    #[test]
    fn joins_repeated_data_fields_with_newlines() {
        let read = frames(&["data: one\ndata: two\n\n"]);
        assert_eq!(read[0].data, "one\ntwo");
        assert_eq!(read[0].kind, "message", "no event name is the default type");
    }

    #[test]
    fn reads_crlf_the_same_as_lf() {
        let read = frames(&["event: rendition\r\ndata: one\r\n\r\n"]);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].data, "one");
    }

    /// A field's value keeps its own colons, which JSON is full of, and loses only the one
    /// space the format allows after the separator.
    #[test]
    fn splits_a_field_at_its_first_colon_only() {
        let read = frames(&["data: {\"at\":\"12:30\"}\n\n"]);
        assert_eq!(read[0].data, "{\"at\":\"12:30\"}");
    }

    /// Each event stands alone: a name on one must not colour the next.
    #[test]
    fn does_not_carry_a_name_between_events() {
        let read = frames(&["event: rendition\ndata: one\n\ndata: two\n\n"]);
        assert_eq!(read[0].kind, "rendition");
        assert_eq!(read[1].kind, "message");
    }
}

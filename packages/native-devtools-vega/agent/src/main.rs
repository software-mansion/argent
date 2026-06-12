//! argent-vega-agent — a tiny on-device command agent for Argent Vega automation.
//!
//! Runs on the Vega (Fire TV) virtual device as the unprivileged `app_user`, listens
//! on a localhost TCP port (reached from the host via `adb forward`), and executes
//! automation commands without paying the per-call `vega run-cmd`/vda handshake.
//!
//! Protocol: HTTP/1.1 keep-alive, JSON bodies.
//!   GET  /ping       -> {"ok":true,"version":..,"protocol":"vega-agent/1"}
//!   POST /cmd        -> {"op":"<name>","args":{..}} => {"ok":true,"result":..}
//!                       ops: button{keys:[KEY_*]}, text{text}, shell{cmd,timeoutMs},
//!                            getPageSource{}
//!   POST /shutdown   -> {"ok":true} then exit
//!
//! std-only except for serde_json. Single-threaded accept loop with a thread per
//! connection; commands are cheap and the host serializes requests.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL: &str = "vega-agent/1";
const DEFAULT_PORT: u16 = 8384;
const TOOLKIT_PORT: u16 = 8383; // on-device automation toolkit (getPageSource)
const DEFAULT_HOLD_MS: u64 = 1; // short press; the inputd default (~270ms) is far slower

/// A held-open `inputd-cli start` REPL. Spawning inputd-cli per key costs ~270ms
/// (connection setup + a long default press hold); piping commands into one
/// long-lived REPL with a short holdDuration drops that to ~5ms/key.
struct Repl {
    /// Owned only to keep the inputd-cli process alive; never read directly.
    _child: Child,
    stdin: ChildStdin,
    /// Confirmation lines from inputd-cli stdout, drained by a reader thread.
    rx: Receiver<String>,
}

/// Process-wide singleton REPL, lazily started on first injection and respawned
/// if it dies. Serializing injection through this Mutex is fine — presses are
/// inherently ordered and the host serializes requests anyway.
static REPL: Mutex<Option<Repl>> = Mutex::new(None);

fn main() {
    let mut port = DEFAULT_PORT;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--version" | "-v" => {
                // Machine-readable line the host install-check greps for.
                println!("argent-vega-agent {VERSION}");
                return;
            }
            "--port" | "-p" => {
                if let Some(p) = args.next() {
                    port = p.parse().unwrap_or(DEFAULT_PORT);
                }
            }
            _ => {}
        }
    }

    let addr = format!("127.0.0.1:{port}");
    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("argent-vega-agent: failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("argent-vega-agent {VERSION} listening on {addr} ({PROTOCOL})");

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                std::thread::spawn(move || handle_conn(s));
            }
            Err(e) => eprintln!("argent-vega-agent: accept error: {e}"),
        }
    }
}

/// Serve one TCP connection, looping over keep-alive requests until close.
fn handle_conn(stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut writer = stream;

    loop {
        let req = match read_request(&mut reader) {
            Ok(Some(r)) => r,
            Ok(None) => return, // clean EOF
            Err(_) => return,
        };

        let keep_alive = req.keep_alive;
        let (status, body) = route(&req);

        if write_response(&mut writer, status, &body, keep_alive).is_err() {
            return;
        }

        if req.shutdown {
            eprintln!("argent-vega-agent: shutdown requested");
            std::process::exit(0);
        }
        if !keep_alive {
            return;
        }
    }
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
    keep_alive: bool,
    shutdown: bool,
}

/// Parse one HTTP/1.1 request. Returns Ok(None) on a clean connection close.
fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    let n = reader.read_line(&mut line)?;
    if n == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();

    // HTTP/1.1 defaults to keep-alive unless Connection: close.
    let mut keep_alive = version.contains("1.1");
    let mut content_length = 0usize;

    loop {
        let mut h = String::new();
        let hn = reader.read_line(&mut h)?;
        if hn == 0 {
            return Ok(None);
        }
        let trimmed = h.trim_end();
        if trimmed.is_empty() {
            break; // end of headers
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            match name.as_str() {
                "content-length" => content_length = value.parse().unwrap_or(0),
                "connection" => {
                    let v = value.to_ascii_lowercase();
                    if v.contains("close") {
                        keep_alive = false;
                    } else if v.contains("keep-alive") {
                        keep_alive = true;
                    }
                }
                _ => {}
            }
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    Ok(Some(Request {
        method,
        path,
        body,
        keep_alive,
        shutdown: false,
    }))
}

/// Dispatch a request to a handler, returning (http_status, json_body).
fn route(req: &Request) -> (u16, Value) {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/ping") => (
            200,
            json!({"ok": true, "version": VERSION, "protocol": PROTOCOL}),
        ),
        ("POST", "/shutdown") => {
            // The actual exit happens in handle_conn after the response is flushed.
            (200, json!({"ok": true}))
        }
        ("POST", "/cmd") => match serde_json::from_slice::<Value>(&req.body) {
            Ok(v) => (200, handle_cmd(&v)),
            Err(e) => (200, err_envelope("BadRequest", &format!("invalid JSON: {e}"))),
        },
        _ => (404, err_envelope("NotFound", "unknown route")),
    }
}

/// Execute a {"op","args"} command, returning the JSON envelope.
fn handle_cmd(v: &Value) -> Value {
    let op = v.get("op").and_then(Value::as_str).unwrap_or("");
    let args = v.get("args").cloned().unwrap_or(json!({}));
    match op {
        "button" => op_button(&args),
        "text" => op_text(&args),
        "getPageSource" => op_get_page_source(),
        "shell" => op_shell(&args),
        _ => err_envelope("UnknownOp", &format!("unknown op: {op}")),
    }
}

/// Inject one or more D-pad/remote key presses via the held-open inputd REPL.
fn op_button(args: &Value) -> Value {
    let keys: Vec<String> = args
        .get("keys")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|k| k.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if keys.is_empty() {
        return err_envelope("BadArgs", "button requires non-empty keys[]");
    }
    let hold = args.get("holdMs").and_then(Value::as_u64).unwrap_or(DEFAULT_HOLD_MS);

    let mut pressed = 0u32;
    for key in &keys {
        // Whitelist: KEY_* uppercase identifiers only — never reaches a shell, but
        // it is also written into the REPL line, so keep it strict.
        if !is_safe_keycode(key) {
            return err_envelope("BadArgs", &format!("invalid keycode: {key}"));
        }
        let line = format!("button_press {key} holdDuration {hold}");
        if let Err(e) = repl_send(&line) {
            return err_envelope("InjectFailed", &format!("button_press {key}: {e}"));
        }
        pressed += 1;
    }
    json!({"ok": true, "result": {"pressed": pressed}})
}

/// Type text into the focused field via the held-open inputd REPL.
fn op_text(args: &Value) -> Value {
    let text = match args.get("text").and_then(Value::as_str) {
        Some(t) => t,
        None => return err_envelope("BadArgs", "text requires a string `text`"),
    };
    // send_text reads the rest of the line, so a newline would truncate it; the
    // REPL is line-oriented and cannot carry embedded newlines.
    if text.contains('\n') || text.contains('\r') {
        return err_envelope("BadArgs", "text must not contain newlines");
    }
    match repl_send(&format!("send_text {text}")) {
        Ok(()) => json!({"ok": true, "result": {"chars": text.chars().count()}}),
        Err(e) => err_envelope("InjectFailed", &format!("send_text: {e}")),
    }
}

/// Send one command line to the inputd REPL and wait for its `Injecting`
/// confirmation. Starts the REPL on first use and respawns it once if it died.
fn repl_send(line: &str) -> Result<(), String> {
    let mut guard = REPL.lock().map_err(|_| "repl mutex poisoned".to_string())?;
    for attempt in 0..2 {
        if guard.is_none() {
            *guard = Some(spawn_repl().map_err(|e| format!("spawn inputd-cli start: {e}"))?);
        }
        let repl = guard.as_mut().unwrap();
        let write_ok = writeln!(repl.stdin, "{line}").and_then(|_| repl.stdin.flush());
        if write_ok.is_err() {
            *guard = None; // pipe broke — respawn and retry
            continue;
        }
        // Drain confirmation lines until inputd acknowledges the injection.
        loop {
            match repl.rx.recv_timeout(Duration::from_secs(3)) {
                Ok(l) if l.contains("Injecting") => return Ok(()),
                Ok(_) => continue, // banner / prompt noise
                Err(RecvTimeoutError::Timeout) => {
                    return Err("inputd-cli did not acknowledge in time".to_string())
                }
                Err(RecvTimeoutError::Disconnected) => {
                    *guard = None;
                    break; // reader thread ended → REPL died, respawn on next attempt
                }
            }
        }
        let _ = attempt;
    }
    Err("inputd-cli REPL unavailable after respawn".to_string())
}

/// Spawn `inputd-cli start` and a reader thread that forwards its stdout lines.
fn spawn_repl() -> std::io::Result<Repl> {
    let mut child = Command::new("inputd-cli")
        .arg("start")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        // inputd separates lines with "\n\r"; read_line on '\n' is sufficient.
        loop {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) | Err(_) => break, // EOF / error → drop tx, signals death
                Ok(_) => {
                    if tx.send(buf.trim_end().to_string()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    Ok(Repl {
        _child: child,
        stdin,
        rx,
    })
}

/// Proxy getPageSource to the on-device automation toolkit on 127.0.0.1:8383.
fn op_get_page_source() -> Value {
    let rpc = json!({"jsonrpc":"2.0","id":1,"method":"getPageSource","params":{}}).to_string();
    match toolkit_jsonrpc(&rpc) {
        Ok(body) => match serde_json::from_str::<Value>(&body) {
            Ok(v) => {
                if let Some(result) = v.get("result") {
                    let xml = match result {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    json!({"ok": true, "result": {"xml": xml}})
                } else if let Some(e) = v.get("error") {
                    err_envelope("ToolkitError", &e.to_string())
                } else {
                    err_envelope("ToolkitError", "no result in toolkit response")
                }
            }
            Err(e) => err_envelope("ToolkitError", &format!("bad toolkit JSON: {e}")),
        },
        Err(e) => err_envelope("ToolkitUnavailable", &e),
    }
}

/// Minimal HTTP POST to the toolkit's /jsonrpc, returning the response body.
fn toolkit_jsonrpc(body: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", TOOLKIT_PORT))
        .map_err(|e| format!("connect :{TOOLKIT_PORT}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok();
    let req = format!(
        "POST /jsonrpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    // Split headers from body on the blank line.
    match text.split_once("\r\n\r\n") {
        Some((_, b)) => Ok(b.to_string()),
        None => Err("malformed toolkit response".to_string()),
    }
}

/// Internal escape hatch: run a shell command with a timeout.
fn op_shell(args: &Value) -> Value {
    let cmd = match args.get("cmd").and_then(Value::as_str) {
        Some(c) => c,
        None => return err_envelope("BadArgs", "shell requires a string `cmd`"),
    };
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(5000);

    let mut child = match Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return err_envelope("SpawnFailed", &format!("{e}")),
    };

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return err_envelope("Timeout", &format!("shell exceeded {timeout_ms}ms"));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return err_envelope("WaitFailed", &format!("{e}")),
        }
    }

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => return err_envelope("WaitFailed", &format!("{e}")),
    };
    json!({
        "ok": true,
        "result": {
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
            "exit": output.status.code().unwrap_or(-1),
        }
    })
}

fn is_safe_keycode(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 32
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn err_envelope(kind: &str, message: &str) -> Value {
    json!({"ok": false, "error": {"type": kind, "message": message}})
}

fn write_response(
    writer: &mut TcpStream,
    status: u16,
    body: &Value,
    keep_alive: bool,
) -> std::io::Result<()> {
    let body_bytes = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Error",
    };
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: {conn}\r\n\r\n",
        body_bytes.len()
    );
    writer.write_all(head.as_bytes())?;
    writer.write_all(&body_bytes)?;
    writer.flush()
}

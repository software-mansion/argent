# Feasibility: moving screen recording onto simulator-server

**Question.** Can we drop argent's host-side capture pipeline (subscribe to
simulator-server's MJPEG stream, pace frames into an `ffmpeg` child that encodes
the mp4) and instead have simulator-server record and save the video itself?

**TL;DR.** It is **technically feasible and works** - simulator-server has a
`recording` feature that encodes the screen to h264 server-side and muxes an mp4
on demand, and it captures the touch-pointer overlay for free. But it is **not a
good trade for argent today**, and this PR intentionally does **not** perform the
rework. The server-side API is a _replay buffer_ ("save the last N seconds"),
not a _session recorder_; adopting it would regress the watermark and
static-trim features we just shipped, and depends on a simulator-server binary
argent does not currently ship. Details and evidence below.

---

## How server-side recording works

The feature lives behind simulator-server's `recording` cargo feature (radon
`packages/simulator-server`). It is exposed over three HTTP endpoints
(`web_api.rs`), which map to a `VideoService` (`media_handler/video_service.rs`):

- `POST /api/video/start  { id, buffer_size?, in_memory? }` - begin buffering
  h264 frames for `id`. `buffer_size` is in **MB** (default **50**,
  `web_api.rs::default_buffer_size`). `in_memory:false` spills each frame to a
  file under a temp dir; `true` keeps them in RAM.
- `POST /api/video/save   { id, durations?: number[], rotation? }` - mux and
  write mp4(s). For each requested `durations` entry it exports the **last N
  seconds** from the buffer; it always also writes a `-full` export. Returns
  `{ url, path }` (the mp4 on the sim-server host, also served at
  `http://<sim-server>/media/...`).
- `POST /api/video/stop   { id }` - drop the buffer and unregister the encoder.

### The buffer is a byte-capped rolling window, not a session

`FrameStorage` (`media_handler/frame_storage.rs`) is a `VecDeque<StoredFrame>`
bounded by **total encoded bytes** (`max_size = buffer_size_MB * 1024 * 1024`).
On every `store_frame`, once the byte cap is exceeded the **oldest frames are
evicted** (`pop_front`, lines ~94-101). So:

- "Save `-full`" returns only **what is still in the buffer** - the last
  `buffer_size` MB. A long session silently loses its beginning.
- The model is designed for "something happened, save the recent clip" (a
  ShadowPlay-style replay buffer), which is the opposite of argent's
  "record this whole interaction from start to stop" contract.

Frame timing is preserved via per-frame durations, so a still screen collapses
to one long-duration frame rather than bloating - similar in spirit to what the
host pump achieves, but with no deliberate trimming.

### The pointer overlay is baked in for free

`encoder::encode` (`media_handler/encoder.rs:213`) applies the touch-animation
masks to the frame **before** fanning it out to _all_ registered encoders. The
streaming JPEG encoder and the recording h264 encoder therefore receive the same
pointer-overlaid image. So the touch visualizer from
[`showTouches`](./screen-recording-start.ts) (PR #549) would carry over to
server-side recording with no extra work. **The watermark would not** - it is
drawn only by the host-side `ffmpeg` filter graph ([watermark.ts](./watermark.ts));
there is no server-side compositing for it.

---

## Empirical verification

Built a `recording`-enabled simulator-server (`cargo build --features
radon-free`, which is `recording + pointer + streaming`), pointed the tool-server
at it via `ARGENT_SIMULATOR_SERVER_DIR`, and drove the Video API against a booted
iOS 18.5 simulator:

1. `POST /api/pointer {trail:8}` + `{show:true}` -> `{"status":"ok"}`
2. `POST /api/video/start {id:"test", buffer_size:200}` -> `{"status":"ok"}`
3. drove taps + slow swipes through argent's `gesture-tap` / `gesture-swipe`
4. `POST /api/video/save {id:"test", durations:[]}` -> a real mp4
5. `POST /api/video/stop {id:"test"}` -> `{"status":"ok"}`

Result: a valid **h264, 1320x2868, ~6.5s** mp4 that captured the full session
(home screen -> paging -> opening Apple News). The **grey pointer bubbles were
clearly baked into the frames** at each touch point. No watermark, no trimming
(both as predicted). So the mechanism is proven end-to-end, not just on paper.

---

## Why this PR does not do the rework

| Concern                  | Host-side pipeline (today, #517/#548/#549) | Server-side `recording`                            |
| ------------------------ | ------------------------------------------ | -------------------------------------------------- |
| Ships in argent's binary | yes                                        | **no** - `api/video` absent from the bundled build |
| Full start->stop capture | yes, bounded + predictable                 | replay buffer; long sessions lose the start        |
| Watermark (#517)         | yes (ffmpeg)                               | **no server-side compositor**                      |
| Static-frame trim (#548) | yes                                        | no (would need a Rust reimpl)                      |
| Touch overlay (#549)     | yes                                        | **yes, for free**                                  |
| iOS + Android            | yes, uniform, battle-tested                | needs re-validation on both                        |
| Host `ffmpeg` dependency | required                                   | not required                                       |

1. **Not in the shipped binary.** argent bundles a simulator-server built
   _without_ `recording` - `strings <bundled>/simulator-server | grep -c
api/video` is `0` (pointer and streaming are `2`). Adopting server-side
   recording requires radon to add `recording` to the `argent` cargo feature (it
   is currently `argent = []`), cut a new simulator-server release, and argent to
   pin/download it. That is a cross-repo release-pipeline change, and the largest
   and least-controllable cost.
2. **Feature regressions.** The watermark (#517) and static-frame trimming
   (#548) are host-side and have no server-side equivalent; switching would drop
   both unless they are reimplemented inside the Rust encoder/muxer path - a
   large effort across a repo boundary, to re-reach parity we already have.
3. **Semantic mismatch.** The replay-buffer model cannot _guarantee_ a faithful
   full-session recording. The host pipeline already does exactly that, at a
   bounded and predictable cost.

The only clear win is dropping the `ffmpeg` dependency (and offloading encode to
the device host / VideoToolbox). That does not outweigh losing two shipped
features and taking on a cross-repo binary dependency.

---

## When to revisit

Adopt server-side recording if/when:

- **ffmpeg-free operation becomes a hard requirement** (e.g. locked-down
  environments where installing ffmpeg is not acceptable), **and**
- radon ships `recording` in the binary argent bundles, **and**
- the watermark + trim either move server-side or are dropped as requirements.

There is also one capability the host pipeline genuinely cannot match: **"save
the last N seconds" of an already-running session** (`durations`). If that
becomes a product need (e.g. "a crash happened - grab the last 30s"), the Video
API is the right tool and could be added _alongside_ the host pipeline rather
than replacing it.

---

_Evidence gathered against radon `main` (simulator-server v1.17.0) and argent's
bundled darwin simulator-server, July 2026._

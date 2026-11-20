// Serves a cabled iPhone's screen as an MJPEG stream on 127.0.0.1.
//
// Usage: ios-screen-stream [--name <device name>] [--fps <n>] [--quality <0-1>]
//
// macOS exposes a cabled iPhone's screen (what QuickTime's "New Movie
// Recording" shows) as an AVFoundation capture device once the process opts in
// to screen-capture devices through CoreMediaIO. Nothing runs on the phone.
//
// Protocol, one JSON object per stdout line:
//   {"event":"awaiting_permission"}       macOS is asking the user for camera access
//   {"event":"ready","port":N,"device":…} GET http://127.0.0.1:N/ streams frames
//   {"event":"error","code":…,"message":…} then exit 1
// The stream is multipart/x-mixed-replace;boundary=NextFrame, the same shape
// simulator-server serves. The process exits when stdin closes, so it never
// outlives the tool-server that spawned it.
//
// The tool-server compiles this file with `xcrun swiftc` on first use and
// embeds Info.plist (see ios-screen-stream.ts).

import AVFoundation
import CoreImage
import CoreMediaIO
import Foundation
import Network

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  FileHandle.standardOutput.write(data + Data([0x0A]))
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["event": "error", "code": code, "message": message])
  exit(1)
}

// MARK: Responsibility

// Capture needs camera (TCC) access, which macOS checks against the
// *responsible* process: the app that launched the tool-server (an editor, a
// terminal, an agent app). An app without a camera usage string gets a
// promptless denial. Re-spawning with responsibility disclaimed, as terminals
// do for their shells, makes this binary, with its embedded Info.plist, the one
// macOS asks about and remembers.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(
  _ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let disclaimedEnv = "ARGENT_SCREEN_STREAM_DISCLAIMED"
if getenv(disclaimedEnv) == nil {
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
  setenv(disclaimedEnv, "1", 1)
  var child: pid_t = 0
  let rc = posix_spawn(&child, CommandLine.unsafeArgv[0], nil, &attr, CommandLine.unsafeArgv, environ)
  if rc != 0 { fail("spawn_failed", "Could not re-spawn the capture helper (errno \(rc)).") }
  // Pass termination on. The child shares our stdin, so it also exits on EOF.
  var sources: [DispatchSourceSignal] = []
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig)
    source.setEventHandler { kill(child, sig) }
    source.resume()
    sources.append(source)
  }
  DispatchQueue.global().async {
    var status: Int32 = 0
    while waitpid(child, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
  }
  withExtendedLifetime(sources) { dispatchMain() }
}

// MARK: Arguments

var wantedName: String?
var fps = 30.0
var quality = 0.8
do {
  var args = CommandLine.arguments.dropFirst().makeIterator()
  while let arg = args.next() {
    switch arg {
    case "--name": wantedName = args.next()
    case "--fps": fps = Double(args.next() ?? "") ?? fps
    case "--quality": quality = Double(args.next() ?? "") ?? quality
    default: fail("bad_arguments", "Unknown argument \(arg).")
    }
  }
}

// Exit with the parent: stdin EOF means the tool-server let go of us.
DispatchQueue.global().async {
  while FileHandle.standardInput.availableData.count > 0 {}
  exit(0)
}
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

// MARK: Camera permission

let permissionAdvice =
  "Allow \"ios-screen-stream\" in System Settings > Privacy & Security > Camera, then retry."
switch AVCaptureDevice.authorizationStatus(for: .video) {
case .authorized: break
case .notDetermined:
  emit(["event": "awaiting_permission"])
  let answered = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .video) { ok in
    granted = ok
    answered.signal()
  }
  if answered.wait(timeout: .now() + 120) == .timedOut || !granted {
    fail("camera_permission_denied",
      "macOS did not grant the camera access it requires to capture an iPhone screen. \(permissionAdvice)")
  }
default:
  fail("camera_permission_denied",
    "Camera access, which macOS requires to capture an iPhone screen, is denied. \(permissionAdvice)")
}

// MARK: Device discovery

var allowProperty = CMIOObjectPropertyAddress(
  mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
let allowStatus = CMIOObjectSetPropertyData(
  CMIOObjectID(kCMIOObjectSystemObject), &allowProperty, 0, nil,
  UInt32(MemoryLayout<UInt32>.size), &allow)
if allowStatus != 0 {
  fail("helper_failed", "CoreMediaIO refused to expose screen-capture devices (status \(allowStatus)).")
}

/// An iPhone screen is an external, muxed device with model "iOS Device". The
/// phone's Continuity Camera is external too, but carries video media.
func screenDevices() -> [AVCaptureDevice] {
  AVCaptureDevice.DiscoverySession(
    deviceTypes: [.external], mediaType: nil, position: .unspecified
  ).devices.filter { $0.hasMediaType(.muxed) && $0.modelID == "iOS Device" }
}

/// devicectl and AVFoundation may spell the apostrophe in "Name's iPhone" differently.
func normalize(_ s: String) -> String {
  s.replacingOccurrences(of: "\u{2019}", with: "'").lowercased()
}

/// The screen of the named iPhone, or the only one when the name matches none
/// (a renamed phone can keep its old name on one side for a while).
func pickDevice() -> AVCaptureDevice? {
  let all = screenDevices()
  if let wantedName {
    let matches = all.filter { normalize($0.localizedName) == normalize(wantedName) }
    if matches.count > 1 {
      fail("ambiguous_device",
        "\(matches.count) cabled iPhones are named \"\(wantedName)\", so argent cannot tell which screen to record. Rename one in Settings > General > About, or unplug the others.")
    }
    if let match = matches.first { return match }
  }
  if all.count > 1 {
    let names = all.map(\.localizedName).joined(separator: ", ")
    fail("ambiguous_device",
      "\(all.count) cabled iPhones are connected (\(names)) and none is named \"\(wantedName ?? "")\".")
  }
  return all.first
}

// The device appears asynchronously after the opt-in, usually within 0.5s.
var device: AVCaptureDevice?
let discoveryDeadline = Date().addingTimeInterval(5)
while device == nil && Date() < discoveryDeadline {
  device = pickDevice()
  if device == nil { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
}
guard let device else {
  fail("device_not_found",
    "macOS exposes no iPhone screen for capture. Connect the iPhone with a USB cable (not Wi-Fi), unlock it, and trust this Mac.")
}

// MARK: Frames

final class FrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private let context = CIContext(options: [.useSoftwareRenderer: false])
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  private let minInterval: CFTimeInterval
  private let quality: Double
  private var lastEmit: CFTimeInterval = 0
  private let lock = NSLock()
  private var clients: [ObjectIdentifier: NWConnection] = [:]
  private var latest: Data?

  init(fps: Double, quality: Double) {
    minInterval = 1 / max(fps, 1)
    self.quality = quality
  }

  func add(_ connection: NWConnection) {
    lock.lock()
    clients[ObjectIdentifier(connection)] = connection
    let frame = latest
    lock.unlock()
    let head =
      "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace;boundary=NextFrame\r\n"
      + "Cache-Control: no-cache\r\nConnection: close\r\n\r\n--NextFrame"
    send(Data(head.utf8), to: connection)
    // The phone sends nothing while its screen is still; replay the last frame
    // so a new client does not wait for the next change.
    if let frame { send(part(frame), to: connection) }
  }

  func remove(_ connection: NWConnection) {
    lock.lock()
    clients[ObjectIdentifier(connection)] = nil
    lock.unlock()
  }

  /// Each part ends with the next boundary, so a reader that splits on the
  /// boundary has the frame the moment it is written.
  private func part(_ jpeg: Data) -> Data {
    Data("\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".utf8)
      + jpeg + Data("\r\n--NextFrame".utf8)
  }

  private func send(_ data: Data, to connection: NWConnection) {
    connection.send(content: data, completion: .contentProcessed { [weak self] error in
      if error != nil {
        self?.remove(connection)
        connection.cancel()
      }
    })
  }

  func captureOutput(
    _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    let now = CACurrentMediaTime()
    if now - lastEmit < minInterval { return }
    guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer),
      let jpeg = context.jpegRepresentation(
        of: CIImage(cvPixelBuffer: pixels), colorSpace: colorSpace,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality])
    else { return }
    lastEmit = now
    lock.lock()
    latest = jpeg
    let targets = Array(clients.values)
    lock.unlock()
    let payload = part(jpeg)
    for client in targets { send(payload, to: client) }
  }
}

let session = AVCaptureSession()
let input: AVCaptureDeviceInput
do {
  input = try AVCaptureDeviceInput(device: device)
} catch {
  fail("helper_failed", "Could not open \(device.localizedName)'s screen: \(error.localizedDescription)")
}
guard session.canAddInput(input) else {
  fail("helper_failed", "\(device.localizedName)'s screen cannot join a capture session.")
}
session.addInput(input)

let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = true
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
let sink = FrameSink(fps: fps, quality: quality)
output.setSampleBufferDelegate(sink, queue: DispatchQueue(label: "ios-screen-stream.capture"))
guard session.canAddOutput(output) else {
  fail("helper_failed", "Could not attach a video output to \(device.localizedName)'s screen.")
}
session.addOutput(output)

// MARK: HTTP

let listener: NWListener
do {
  let params = NWParameters.tcp
  params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 0)
  listener = try NWListener(using: params)
} catch {
  fail("helper_failed", "Could not open a local port: \(error.localizedDescription)")
}
let serverQueue = DispatchQueue(label: "ios-screen-stream.server")
listener.newConnectionHandler = { connection in
  connection.stateUpdateHandler = { state in
    switch state {
    case .failed, .cancelled: sink.remove(connection)
    default: break
    }
  }
  connection.start(queue: serverQueue)
  // Any request gets the stream; read the head only to know one arrived.
  connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { _, _, _, error in
    if error != nil {
      connection.cancel()
      return
    }
    sink.add(connection)
  }
}
listener.stateUpdateHandler = { state in
  switch state {
  case .ready:
    session.startRunning()
    emit(["event": "ready", "port": Int(listener.port?.rawValue ?? 0), "device": device.localizedName])
  case .failed(let error):
    fail("helper_failed", "The local stream server failed: \(error.localizedDescription)")
  default: break
  }
}
listener.start(queue: serverQueue)

// CoreMediaIO delivers device frames through the main run loop; dispatchMain()
// would leave the session running with no samples.
RunLoop.main.run()

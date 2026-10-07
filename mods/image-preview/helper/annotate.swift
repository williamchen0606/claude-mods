// The image-preview mod's annotation window (macOS only), built by the mod
// with `swiftc` the first time it is needed.
//
//   annotate edit <in.png> <out.png> <title>
//     Opens a floating window over <in.png> with rectangle and arrow tools.
//     Done writes <out.png> and prints `saved <pid>`, the pid being the app
//     that was in front when the window opened (the terminal). Skip, Esc or
//     closing the window prints `skipped`.
//
//   annotate paste <png> <pid>
//     Puts <png> on the clipboard and brings <pid> back to the front. With
//     Accessibility access it then presses Ctrl+V there and prints `pasted`;
//     otherwise prints `copied <why>` so the mod can ask the person to paste.
//     Either line ends with what it saw (trust, target app), for the log.

import AppKit

func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(2)
}

enum Tool: Int {
  case rectangle = 0
  case arrow = 1
}

/// One mark, in the image's pixels, origin at the bottom left.
struct Mark {
  var tool: Tool
  var from: CGPoint
  var to: CGPoint
}

final class Canvas: NSView {
  let image: NSImage
  let pixels: NSSize
  var marks: [Mark] = []
  var drawing: Mark?
  var tool: Tool = .rectangle
  var onDone: () -> Void = {}
  var onSkip: () -> Void = {}
  var onTool: (Tool) -> Void = { _ in }

  init(image: NSImage, pixels: NSSize, frame: NSRect) {
    self.image = image
    self.pixels = pixels
    super.init(frame: frame)
  }

  required init?(coder: NSCoder) { fatalError() }

  override var acceptsFirstResponder: Bool { true }

  /// How many view points one image pixel takes.
  var scale: CGFloat { bounds.width / pixels.width }

  var lineWidth: CGFloat { max(3, min(pixels.width, pixels.height) / 160) }

  func toImage(_ event: NSEvent) -> CGPoint {
    let p = convert(event.locationInWindow, from: nil)
    return CGPoint(
      x: min(max(p.x / scale, 0), pixels.width),
      y: min(max(p.y / scale, 0), pixels.height))
  }

  /// Draws the marks in image pixels; the caller sets up the scale.
  func drawMarks() {
    NSColor.systemRed.setStroke()
    NSColor.systemRed.setFill()
    for mark in marks + (drawing.map { [$0] } ?? []) {
      switch mark.tool {
      case .rectangle:
        let rect = NSRect(
          x: min(mark.from.x, mark.to.x), y: min(mark.from.y, mark.to.y),
          width: abs(mark.to.x - mark.from.x), height: abs(mark.to.y - mark.from.y))
        let path = NSBezierPath(roundedRect: rect, xRadius: lineWidth, yRadius: lineWidth)
        path.lineWidth = lineWidth
        path.stroke()
      case .arrow:
        let angle = atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x)
        let head = lineWidth * 5
        let base = CGPoint(
          x: mark.to.x - cos(angle) * head * 0.8, y: mark.to.y - sin(angle) * head * 0.8)
        let line = NSBezierPath()
        line.move(to: mark.from)
        line.line(to: base)
        line.lineWidth = lineWidth
        line.lineCapStyle = .round
        line.stroke()
        let tip = NSBezierPath()
        tip.move(to: mark.to)
        tip.line(to: CGPoint(x: mark.to.x - cos(angle - 0.45) * head, y: mark.to.y - sin(angle - 0.45) * head))
        tip.line(to: CGPoint(x: mark.to.x - cos(angle + 0.45) * head, y: mark.to.y - sin(angle + 0.45) * head))
        tip.close()
        tip.fill()
      }
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    image.draw(in: bounds)
    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.concat()
    drawMarks()
    NSGraphicsContext.restoreGraphicsState()
  }

  override func mouseDown(with event: NSEvent) {
    let p = toImage(event)
    drawing = Mark(tool: tool, from: p, to: p)
    needsDisplay = true
  }

  override func mouseDragged(with event: NSEvent) {
    drawing?.to = toImage(event)
    needsDisplay = true
  }

  override func mouseUp(with event: NSEvent) {
    if var mark = drawing {
      mark.to = toImage(event)
      if hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) > lineWidth { marks.append(mark) }
    }
    drawing = nil
    needsDisplay = true
  }

  func undo() {
    if !marks.isEmpty { marks.removeLast() }
    needsDisplay = true
  }

  override func keyDown(with event: NSEvent) {
    let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
    if event.modifierFlags.contains(.command) && key == "z" { return undo() }
    switch (event.keyCode, key) {
    case (36, _), (76, _): onDone()
    case (53, _): onSkip()
    case (_, "r"): tool = .rectangle; onTool(.rectangle)
    case (_, "a"): tool = .arrow; onTool(.arrow)
    default: super.keyDown(with: event)
    }
  }

  /// The image with the marks drawn on it, as PNG, at the image's own size.
  func png() -> Data? {
    let width = Int(pixels.width)
    let height = Int(pixels.height)
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }
    rep.size = pixels
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(origin: .zero, size: pixels))
    drawMarks()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
  }
}

final class Editor: NSObject, NSWindowDelegate {
  let output: URL
  let terminal: pid_t
  let canvas: Canvas
  let panel: NSPanel
  let tools: NSSegmentedControl
  var isFinished = false

  init(input: URL, output: URL, title: String) {
    self.output = output
    terminal = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0

    guard let data = try? Data(contentsOf: input),
      let rep = NSBitmapImageRep(data: data),
      let image = NSImage(data: data)
    else { fail("cannot read \(input.path)") }
    let pixels = NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)

    // Show the image at its size on a Retina screen, shrunk to fit the screen.
    let screen = NSScreen.main ?? NSScreen.screens[0]
    let room = screen.visibleFrame.insetBy(dx: 80, dy: 80)
    let natural = NSSize(
      width: pixels.width / screen.backingScaleFactor,
      height: pixels.height / screen.backingScaleFactor)
    let fit = min(1, room.width / natural.width, (room.height - 44) / natural.height)
    let size = NSSize(
      width: max(1, (natural.width * fit).rounded()),
      height: max(1, (natural.height * fit).rounded()))

    canvas = Canvas(image: image, pixels: pixels, frame: NSRect(origin: .zero, size: size))
    tools = NSSegmentedControl(labels: ["矩形 R", "箭頭 A"], trackingMode: .selectOne, target: nil, action: nil)
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: max(size.width, 360), height: size.height + 44),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    super.init()

    tools.selectedSegment = 0
    tools.target = self
    tools.action = #selector(pickTool)
    let undo = NSButton(title: "復原", target: self, action: #selector(undoMark))
    let skip = NSButton(title: "略過", target: self, action: #selector(skip))
    let done = NSButton(title: "完成", target: self, action: #selector(done))
    done.keyEquivalent = "\r"
    skip.keyEquivalent = "\u{1b}"
    let bar = NSStackView(views: [tools, undo, NSView(), skip, done])
    bar.orientation = .horizontal
    bar.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)

    let content = NSView(frame: panel.contentRect(forFrameRect: panel.frame))
    bar.frame = NSRect(x: 0, y: size.height, width: content.frame.width, height: 44)
    bar.autoresizingMask = [.width]
    canvas.frame.origin = NSPoint(x: ((content.frame.width - size.width) / 2).rounded(), y: 0)
    content.addSubview(canvas)
    content.addSubview(bar)

    canvas.onDone = { [unowned self] in self.done() }
    canvas.onSkip = { [unowned self] in self.skip() }
    canvas.onTool = { [unowned self] tool in self.tools.selectedSegment = tool.rawValue }

    panel.title = "標註 \(title)"
    panel.contentView = content
    panel.level = .floating
    panel.delegate = self
    panel.center()
  }

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(canvas)
  }

  @objc func pickTool() {
    canvas.tool = Tool(rawValue: tools.selectedSegment) ?? .rectangle
    panel.makeFirstResponder(canvas)
  }

  @objc func undoMark() {
    canvas.undo()
    panel.makeFirstResponder(canvas)
  }

  @objc func done() {
    guard !isFinished else { return }
    guard let png = canvas.png(), (try? png.write(to: output)) != nil else { fail("cannot write \(output.path)") }
    finish("saved \(terminal)")
  }

  @objc func skip() {
    finish("skipped")
  }

  func windowWillClose(_ notification: Notification) {
    finish("skipped")
  }

  func finish(_ line: String) {
    guard !isFinished else { return }
    isFinished = true
    emit(line)
    exit(0)
  }
}

/// The app in front, read after letting the run loop take the latest
/// activation notices (without that, NSWorkspace answers a stale value).
func frontmost() -> NSRunningApplication? {
  RunLoop.current.run(until: Date().addingTimeInterval(0.05))
  return NSWorkspace.shared.frontmostApplication
}

func describe(_ app: NSRunningApplication?) -> String {
  guard let app else { return "none" }
  return "\(app.bundleIdentifier ?? app.localizedName ?? "?")(\(app.processIdentifier))"
}

/// Presses one key with Control held, the Control key itself going down and
/// up around it as a real press does.
func pressWithControl(_ key: CGKeyCode) {
  let source = CGEventSource(stateID: .combinedSessionState)
  let control: CGKeyCode = 59
  let steps: [(CGKeyCode, Bool, CGEventFlags)] = [
    (control, true, .maskControl), (key, true, .maskControl),
    (key, false, .maskControl), (control, false, []),
  ]
  for (code, isDown, flags) in steps {
    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: isDown)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
    usleep(20_000)
  }
}

func paste(file: URL, terminal: pid_t) -> Never {
  guard let data = try? Data(contentsOf: file) else { fail("cannot read \(file.path)") }
  let board = NSPasteboard.general
  board.clearContents()
  board.setData(data, forType: .png)

  let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  let isTrusted = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
  let target = NSRunningApplication(processIdentifier: terminal)
  let report = "trusted=\(isTrusted) target=\(describe(target)) self=\(CommandLine.arguments[0])"
  guard isTrusted else {
    emit("copied untrusted \(report)")
    exit(0)
  }

  // Bring the terminal back and wait, up to 2s, until it is in front, so
  // the keys reach it and not whatever the window left in front.
  target?.activate(options: [])
  var front = frontmost()
  for _ in 0..<40 where front?.processIdentifier != terminal {
    front = frontmost()
  }
  guard front?.processIdentifier == terminal else {
    emit("copied not-front front=\(describe(front)) \(report)")
    exit(0)
  }
  usleep(150_000)
  pressWithControl(9)  // v
  emit("pasted \(report)")
  exit(0)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "edit" where args.count >= 5:
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let editor = Editor(
    input: URL(fileURLWithPath: args[2]), output: URL(fileURLWithPath: args[3]), title: args[4])
  editor.show()
  app.run()
case "paste" where args.count >= 4:
  paste(file: URL(fileURLWithPath: args[2]), terminal: pid_t(args[3]) ?? 0)
default:
  fail("usage: annotate edit <in.png> <out.png> <title> | annotate paste <png> <pid>")
}

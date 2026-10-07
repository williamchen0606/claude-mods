// The image-preview mod's annotation window (macOS only), built by the mod
// with `swiftc` the first time it is needed.
//
//   annotate edit <in.png> <out.png> <title>
//     Opens a floating window over <in.png> with rectangle, arrow, text,
//     mosaic and numbered-marker tools in five colors. Done writes <out.png>
//     and prints `saved <pid>`, the pid being the app that was in front when
//     the window opened (the terminal). Skip, Esc or closing the window
//     prints `skipped`. The window's size is kept for the next one.
//
//   annotate paste <png> <pid>
//     Puts <png> on the clipboard and brings <pid> back to the front. With
//     Accessibility access it then presses Ctrl+V there and prints
//     `pasted pid=<own pid> ...`, then waits for SIGUSR1 (the mod saw the
//     image arrive) to put back what the clipboard held before, giving up
//     after 15s. Otherwise it prints `copied <why> ...` and leaves the image
//     on the clipboard for the person to paste. Each line ends with what it
//     saw (trust, target app), for the log.

import AppKit

func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(2)
}

enum Tool: Int, CaseIterable {
  case rectangle = 0
  case arrow
  case text
  case mosaic
  case number

  var label: String {
    switch self {
    case .rectangle: return "矩形"
    case .arrow: return "箭頭"
    case .text: return "文字"
    case .mosaic: return "馬賽克"
    case .number: return "編號"
    }
  }

  var key: String {
    switch self {
    case .rectangle: return "r"
    case .arrow: return "a"
    case .text: return "t"
    case .mosaic: return "m"
    case .number: return "n"
    }
  }
}

/// The colors, picked with the keys 1 to 5.
let palette: [NSColor] = [.systemRed, .systemYellow, .systemGreen, .systemBlue, .black]

/// One mark, in the image's pixels, origin at the bottom left.
struct Mark {
  var tool: Tool
  var color: NSColor
  var from: CGPoint
  var to: CGPoint
  var text = ""
  var number = 0
}

final class Canvas: NSView, NSTextFieldDelegate {
  let image: NSImage
  let pixels: NSSize
  /// The image coarsened into blocks, drawn through a mosaic mark's rect.
  let coarse: NSImage
  var marks: [Mark] = []
  var drawing: Mark?
  var tool: Tool = .rectangle
  var color: NSColor = palette[0]
  var field: NSTextField?
  var fieldAnchor = CGPoint.zero
  var onDone: () -> Void = {}
  var onSkip: () -> Void = {}
  var onTool: (Tool) -> Void = { _ in }
  var onColor: (Int) -> Void = { _ in }

  init(image: NSImage, pixels: NSSize) {
    self.image = image
    self.pixels = pixels
    let block = max(8, min(pixels.width, pixels.height) / 60)
    let small = NSSize(
      width: max(1, (pixels.width / block).rounded()), height: max(1, (pixels.height / block).rounded()))
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(small.width), pixelsHigh: Int(small.height),
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = small
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(origin: .zero, size: small))
    NSGraphicsContext.restoreGraphicsState()
    coarse = NSImage(size: pixels)
    coarse.addRepresentation(rep)
    super.init(frame: NSRect(origin: .zero, size: pixels))
  }

  required init?(coder: NSCoder) { fatalError() }

  override var acceptsFirstResponder: Bool { true }

  /// How many view points one image pixel takes.
  var scale: CGFloat { bounds.width / pixels.width }

  var lineWidth: CGFloat { max(3, min(pixels.width, pixels.height) / 160) }
  var fontSize: CGFloat { lineWidth * 7 }
  var markerRadius: CGFloat { lineWidth * 4.5 }

  func toImage(_ event: NSEvent) -> CGPoint {
    let p = convert(event.locationInWindow, from: nil)
    return CGPoint(
      x: min(max(p.x / scale, 0), pixels.width),
      y: min(max(p.y / scale, 0), pixels.height))
  }

  func textAttributes(_ color: NSColor, size: CGFloat) -> [NSAttributedString.Key: Any] {
    // A negative stroke width fills and outlines, so the text reads on any background.
    let outline: NSColor = color == .black ? .white : .black
    return [
      .font: NSFont.boldSystemFont(ofSize: size), .foregroundColor: color,
      .strokeColor: outline.withAlphaComponent(0.6), .strokeWidth: -2.5,
    ]
  }

  /// Draws the marks in image pixels; the caller sets up the scale.
  func drawMarks() {
    for mark in marks + (drawing.map { [$0] } ?? []) {
      mark.color.setStroke()
      mark.color.setFill()
      let rect = NSRect(
        x: min(mark.from.x, mark.to.x), y: min(mark.from.y, mark.to.y),
        width: abs(mark.to.x - mark.from.x), height: abs(mark.to.y - mark.from.y))
      switch mark.tool {
      case .rectangle:
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
      case .mosaic:
        NSGraphicsContext.saveGraphicsState()
        let interpolation = NSGraphicsContext.current?.imageInterpolation ?? .default
        NSGraphicsContext.current?.imageInterpolation = .none
        NSBezierPath(rect: rect).addClip()
        coarse.draw(in: NSRect(origin: .zero, size: pixels))
        NSGraphicsContext.current?.imageInterpolation = interpolation
        NSGraphicsContext.restoreGraphicsState()
      case .text:
        let text = NSAttributedString(string: mark.text, attributes: textAttributes(mark.color, size: fontSize))
        text.draw(at: CGPoint(x: mark.from.x, y: mark.from.y - text.size().height))
      case .number:
        let r = markerRadius
        NSBezierPath(ovalIn: NSRect(x: mark.from.x - r, y: mark.from.y - r, width: r * 2, height: r * 2)).fill()
        let digits = NSAttributedString(
          string: String(mark.number),
          attributes: [
            .font: NSFont.boldSystemFont(ofSize: r * 1.1),
            .foregroundColor: mark.color == .systemYellow ? NSColor.black : NSColor.white,
          ])
        let size = digits.size()
        digits.draw(at: CGPoint(x: mark.from.x - size.width / 2, y: mark.from.y - size.height / 2))
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

  override func setFrameSize(_ newSize: NSSize) {
    // A text being typed is placed in view points; settle it before they change.
    commitText()
    super.setFrameSize(newSize)
  }

  override func mouseDown(with event: NSEvent) {
    commitText()
    let p = toImage(event)
    switch tool {
    case .text:
      beginText(at: p)
    case .number:
      let next = marks.filter { $0.tool == .number }.count + 1
      marks.append(Mark(tool: .number, color: color, from: p, to: p, number: next))
      needsDisplay = true
    default:
      drawing = Mark(tool: tool, color: color, from: p, to: p)
      needsDisplay = true
    }
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

  func beginText(at p: CGPoint) {
    let size = fontSize * scale
    let height = (size * 1.5).rounded()
    let box = NSTextField(
      frame: NSRect(x: p.x * scale - 3, y: p.y * scale - height, width: max(160, bounds.width - p.x * scale), height: height))
    box.font = NSFont.boldSystemFont(ofSize: size)
    box.textColor = color
    box.backgroundColor = NSColor.white.withAlphaComponent(0.7)
    box.drawsBackground = true
    box.isBordered = false
    box.focusRingType = .none
    box.placeholderString = "輸入文字，Enter 完成"
    box.delegate = self
    addSubview(box)
    window?.makeFirstResponder(box)
    field = box
    fieldAnchor = p
  }

  /// Turns the text being typed into a mark (nothing when it is empty).
  func commitText() {
    guard let box = field else { return }
    field = nil
    let text = box.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      marks.append(Mark(tool: .text, color: box.textColor ?? color, from: fieldAnchor, to: fieldAnchor, text: text))
    }
    box.removeFromSuperview()
    window?.makeFirstResponder(self)
    needsDisplay = true
  }

  func cancelText() {
    field?.stringValue = ""
    commitText()
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if selector == #selector(NSResponder.insertNewline(_:)) {
      commitText()
      return true
    }
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      cancelText()
      return true
    }
    return false
  }

  func undo() {
    if field != nil { return cancelText() }
    if !marks.isEmpty { marks.removeLast() }
    needsDisplay = true
  }

  func pick(_ next: Tool) {
    commitText()
    tool = next
    onTool(next)
  }

  func pickColor(_ index: Int) {
    color = palette[index]
    field?.textColor = color
    onColor(index)
  }

  override func keyDown(with event: NSEvent) {
    let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
    if event.modifierFlags.contains(.command) && key == "z" { return undo() }
    if event.keyCode == 36 || event.keyCode == 76 { return onDone() }
    if event.keyCode == 53 { return onSkip() }
    if let next = Tool.allCases.first(where: { $0.key == key }) { return pick(next) }
    if let digit = Int(key), (1...palette.count).contains(digit) { return pickColor(digit - 1) }
    super.keyDown(with: event)
  }

  /// The image with the marks drawn on it, as PNG, at the image's own size.
  func png() -> Data? {
    commitText()
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

/// The window's content: the tool bar along the top and the canvas fitted,
/// aspect kept and centered, in the rest, whatever size the window is.
final class Container: NSView {
  static let barHeight: CGFloat = 44
  let bar: NSView
  let canvas: Canvas

  init(bar: NSView, canvas: Canvas, frame: NSRect) {
    self.bar = bar
    self.canvas = canvas
    super.init(frame: frame)
    addSubview(canvas)
    addSubview(bar)
    place()
  }

  required init?(coder: NSCoder) { fatalError() }

  override func resizeSubviews(withOldSize oldSize: NSSize) {
    place()
  }

  func place() {
    let barHeight = Container.barHeight
    bar.frame = NSRect(x: 0, y: bounds.height - barHeight, width: bounds.width, height: barHeight)
    let room = NSSize(width: bounds.width - 16, height: max(1, bounds.height - barHeight - 8))
    let fit = max(0.01, min(room.width / canvas.pixels.width, room.height / canvas.pixels.height))
    let size = NSSize(
      width: max(1, (canvas.pixels.width * fit).rounded()), height: max(1, (canvas.pixels.height * fit).rounded()))
    canvas.frame = NSRect(
      x: ((bounds.width - size.width) / 2).rounded(), y: ((room.height - size.height) / 2 + 4).rounded(),
      width: size.width, height: size.height)
    canvas.needsDisplay = true
  }
}

/// Where the window's last size is kept, across windows and sessions.
let sizeFile = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Application Support/claude-image-preview/window.json")

func savedSize() -> NSSize? {
  guard let data = try? Data(contentsOf: sizeFile),
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
    let width = object["width"], let height = object["height"]
  else { return nil }
  return NSSize(width: width, height: height)
}

func saveSize(_ size: NSSize) {
  let object = ["width": Double(size.width.rounded()), "height": Double(size.height.rounded())]
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  try? FileManager.default.createDirectory(
    at: sizeFile.deletingLastPathComponent(), withIntermediateDirectories: true)
  try? data.write(to: sizeFile)
}

func swatch(_ color: NSColor) -> NSImage {
  NSImage(size: NSSize(width: 14, height: 14), flipped: false) { rect in
    color.setFill()
    NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
    NSColor.gray.withAlphaComponent(0.5).setStroke()
    NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).stroke()
    return true
  }
}

final class Editor: NSObject, NSWindowDelegate {
  static let minSize = NSSize(width: 620, height: 320)
  let output: URL
  let terminal: pid_t
  let canvas: Canvas
  let panel: NSPanel
  let tools: NSSegmentedControl
  let colors: NSSegmentedControl
  var isFinished = false

  init(input: URL, output: URL, title: String) {
    self.output = output
    terminal = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0

    guard let data = try? Data(contentsOf: input),
      let rep = NSBitmapImageRep(data: data),
      let image = NSImage(data: data)
    else { fail("cannot read \(input.path)") }
    let pixels = NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    canvas = Canvas(image: image, pixels: pixels)

    // The last size the person left the window at; else the image at its
    // size on a Retina screen. Either way within the screen.
    let screen = NSScreen.main ?? NSScreen.screens[0]
    let room = screen.visibleFrame.insetBy(dx: 40, dy: 40).size
    var size = savedSize() ?? {
      let natural = NSSize(
        width: pixels.width / screen.backingScaleFactor, height: pixels.height / screen.backingScaleFactor)
      let fit = min(1, (room.width - 16) / natural.width, (room.height - Container.barHeight - 8) / natural.height)
      return NSSize(width: natural.width * fit + 16, height: natural.height * fit + Container.barHeight + 8)
    }()
    size.width = min(max(size.width, Editor.minSize.width), room.width)
    size.height = min(max(size.height, Editor.minSize.height), room.height)

    tools = NSSegmentedControl(
      labels: Tool.allCases.map(\.label), trackingMode: .selectOne, target: nil, action: nil)
    colors = NSSegmentedControl(
      images: palette.map(swatch), trackingMode: .selectOne, target: nil, action: nil)
    panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    super.init()

    for tool in Tool.allCases {
      tools.setToolTip("\(tool.label)（\(tool.key.uppercased())）", forSegment: tool.rawValue)
    }
    for index in palette.indices {
      colors.setToolTip("顏色 \(index + 1)", forSegment: index)
    }
    tools.selectedSegment = 0
    tools.target = self
    tools.action = #selector(pickTool)
    colors.selectedSegment = 0
    colors.target = self
    colors.action = #selector(pickColor)
    let undo = NSButton(title: "復原", target: self, action: #selector(undoMark))
    undo.toolTip = "⌘Z"
    let skip = NSButton(title: "略過", target: self, action: #selector(skip))
    skip.toolTip = "Esc"
    let done = NSButton(title: "完成", target: self, action: #selector(done))
    done.toolTip = "Enter"
    done.bezelColor = .controlAccentColor
    let spacer = NSView()
    spacer.setContentHuggingPriority(.init(1), for: .horizontal)
    let bar = NSStackView(views: [tools, colors, undo, spacer, skip, done])
    bar.orientation = .horizontal
    bar.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)

    canvas.onDone = { [unowned self] in self.done() }
    canvas.onSkip = { [unowned self] in self.skip() }
    canvas.onTool = { [unowned self] tool in self.tools.selectedSegment = tool.rawValue }
    canvas.onColor = { [unowned self] index in self.colors.selectedSegment = index }

    panel.title = "標註 \(title)"
    panel.contentView = Container(bar: bar, canvas: canvas, frame: NSRect(origin: .zero, size: size))
    panel.contentMinSize = Editor.minSize
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
    canvas.pick(Tool(rawValue: tools.selectedSegment) ?? .rectangle)
    panel.makeFirstResponder(canvas)
  }

  @objc func pickColor() {
    canvas.pickColor(max(0, colors.selectedSegment))
    if canvas.field == nil { panel.makeFirstResponder(canvas) }
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

  func windowDidEndLiveResize(_ notification: Notification) {
    saveSize(panel.contentRect(forFrameRect: panel.frame).size)
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

/// Everything the clipboard holds, item by item and type by type.
typealias Clipboard = [[NSPasteboard.PasteboardType: Data]]

func copyClipboard(_ board: NSPasteboard) -> Clipboard {
  (board.pasteboardItems ?? []).map { item in
    var types: [NSPasteboard.PasteboardType: Data] = [:]
    for type in item.types {
      if let data = item.data(forType: type) { types[type] = data }
    }
    return types
  }
}

func restoreClipboard(_ saved: Clipboard, to board: NSPasteboard) {
  board.clearContents()
  let items = saved.map { types -> NSPasteboardItem in
    let item = NSPasteboardItem()
    for (type, data) in types { item.setData(data, forType: type) }
    return item
  }
  if !items.isEmpty { board.writeObjects(items) }
}

func paste(file: URL, terminal: pid_t) -> Never {
  guard let data = try? Data(contentsOf: file) else { fail("cannot read \(file.path)") }
  let board = NSPasteboard.general
  let saved = copyClipboard(board)
  board.clearContents()
  board.setData(data, forType: .png)
  let ours = board.changeCount

  let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  let isTrusted = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
  let target = NSRunningApplication(processIdentifier: terminal)
  let report = "pid=\(getpid()) trusted=\(isTrusted) target=\(describe(target)) self=\(CommandLine.arguments[0])"
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

  // Claude Code reads the clipboard after the keys arrive; the mod signals
  // once the new [Image #N] is in the box. Put back what was there, unless
  // something else was copied since.
  signal(SIGUSR1, SIG_IGN)
  let restore = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
  restore.setEventHandler {
    if board.changeCount == ours { restoreClipboard(saved, to: board) }
    exit(0)
  }
  restore.resume()
  DispatchQueue.main.asyncAfter(deadline: .now() + 15) { exit(0) }
  dispatchMain()
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

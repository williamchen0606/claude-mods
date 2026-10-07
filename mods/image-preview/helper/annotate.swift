// The image-preview mod's annotation window (macOS only), built by the mod
// with `swiftc` the first time it is needed.
//
//   annotate edit <in.png> <out.png> <title>
//     Opens a floating window over <in.png> with rectangle, arrow, text,
//     mosaic and numbered-marker tools, five colors and five sizes. Marks
//     may reach past the picture: the result grows to hold them, on white.
//     Done writes <out.png> and prints `saved <pid>`, the pid being the app
//     that was in front when the window opened (the terminal). Skip, Esc or
//     closing the window prints `skipped`. The window's size is kept for the
//     next one.
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

  /// The SF Symbol drawn on the tool's button.
  var symbol: String {
    switch self {
    case .rectangle: return "rectangle"
    case .arrow: return "arrow.up.right"
    case .text: return "textformat"
    case .mosaic: return "square.grid.3x3.fill"
    case .number: return "1.circle"
    }
  }
}

/// The colors, picked with the keys 1 to 5.
let palette: [NSColor] = [.systemRed, .systemYellow, .systemGreen, .systemBlue, .black]

/// The five sizes, in points: a line's width and a text's size at each.
let lineSizes: [CGFloat] = [1, 1.5, 2, 3, 4.5]
let textSizes: [CGFloat] = [10, 12, 14, 18, 24]
let defaultSize = 2

/// One mark, in the image's pixels, origin at the image's bottom left; it may
/// lie past the image's edges. `size` is the line width, or the text size.
struct Mark {
  var tool: Tool
  var color: NSColor
  var size: CGFloat
  var from: CGPoint
  var to: CGPoint
  var text = ""
  var number = 0
}

func textAttributes(_ color: NSColor, size: CGFloat) -> [NSAttributedString.Key: Any] {
  // A negative stroke width fills and outlines, so the text reads on any background.
  let outline: NSColor = color == .black ? .white : .black
  return [
    .font: NSFont.boldSystemFont(ofSize: size), .foregroundColor: color,
    .strokeColor: outline.withAlphaComponent(0.6), .strokeWidth: -2.5,
  ]
}

final class Canvas: NSView, NSTextFieldDelegate {
  let image: NSImage
  let pixels: NSSize
  /// Image pixels per point: the screen's, more for a large picture, so
  /// sizes read the same on any image.
  let unit: CGFloat
  /// The image coarsened into blocks, drawn through a mosaic mark's rect.
  let coarse: NSImage
  var marks: [Mark] = []
  var drawing: Mark?
  var tool: Tool = .rectangle
  var color: NSColor = palette[0]
  var level = defaultSize
  var field: NSTextField?
  var fieldAnchor = CGPoint.zero
  /// The part of the image plane in view, in image pixels: the picture and
  /// the marks with room around them. Settled between strokes, not during one.
  var shown = NSRect.zero
  var onDone: () -> Void = {}
  var onSkip: () -> Void = {}
  var onTool: (Tool) -> Void = { _ in }
  var onColor: (Int) -> Void = { _ in }
  var onLevel: (Int) -> Void = { _ in }

  init(image: NSImage, pixels: NSSize, screenScale: CGFloat) {
    self.image = image
    self.pixels = pixels
    unit = max(screenScale, min(pixels.width, pixels.height) / 500)
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
    refit()
  }

  required init?(coder: NSCoder) { fatalError() }

  override var acceptsFirstResponder: Bool { true }

  var imageRect: NSRect { NSRect(origin: .zero, size: pixels) }
  var lineWidth: CGFloat { lineSizes[level] * unit }
  var textSize: CGFloat { textSizes[level] * unit }

  /// How many view points one image pixel takes.
  var scale: CGFloat {
    guard shown.width > 0, shown.height > 0, bounds.width > 0, bounds.height > 0 else { return 1 }
    return min(bounds.width / shown.width, bounds.height / shown.height)
  }

  /// The image point drawn at the view's bottom-left corner, `shown` centered.
  var origin: CGPoint {
    CGPoint(
      x: shown.midX - bounds.width / scale / 2, y: shown.midY - bounds.height / scale / 2)
  }

  func toImage(_ event: NSEvent) -> CGPoint {
    let p = convert(event.locationInWindow, from: nil)
    return CGPoint(x: p.x / scale + origin.x, y: p.y / scale + origin.y)
  }

  func toView(_ p: CGPoint) -> CGPoint {
    CGPoint(x: (p.x - origin.x) * scale, y: (p.y - origin.y) * scale)
  }

  /// What a mark covers, to grow the result by; a mosaic only ever covers
  /// the picture, so it grows nothing.
  func cover(_ mark: Mark) -> NSRect {
    let box = NSRect(
      x: min(mark.from.x, mark.to.x), y: min(mark.from.y, mark.to.y),
      width: abs(mark.to.x - mark.from.x), height: abs(mark.to.y - mark.from.y))
    switch mark.tool {
    case .rectangle, .arrow:
      let pad = mark.tool == .arrow ? arrowHead(mark.size) : mark.size
      return box.insetBy(dx: -pad, dy: -pad)
    case .mosaic:
      return .null
    case .text:
      let size = NSAttributedString(string: mark.text, attributes: textAttributes(mark.color, size: mark.size)).size()
      return NSRect(x: mark.from.x, y: mark.from.y - size.height, width: size.width, height: size.height)
    case .number:
      let r = markerRadius(mark.size)
      return NSRect(x: mark.from.x - r, y: mark.from.y - r, width: r * 2, height: r * 2)
    }
  }

  /// The result's bounds: the picture and every mark, whole pixels.
  var resultRect: NSRect {
    NSIntegralRect(marks.reduce(imageRect) { $0.union(cover($1)) })
  }

  /// Settles what the view shows: the result with room around it to draw in.
  func refit() {
    let rect = resultRect
    let room = max(40 * unit, max(rect.width, rect.height) * 0.08)
    shown = rect.insetBy(dx: -room, dy: -room)
    needsDisplay = true
  }

  func arrowHead(_ width: CGFloat) -> CGFloat { max(width * 4.5, 7 * unit) }
  func markerRadius(_ textSize: CGFloat) -> CGFloat { textSize * 0.85 }

  /// Draws the marks in image pixels; the caller sets up the transform.
  func drawMarks() {
    for mark in marks + (drawing.map { [$0] } ?? []) {
      mark.color.setStroke()
      mark.color.setFill()
      let rect = NSRect(
        x: min(mark.from.x, mark.to.x), y: min(mark.from.y, mark.to.y),
        width: abs(mark.to.x - mark.from.x), height: abs(mark.to.y - mark.from.y))
      switch mark.tool {
      case .rectangle:
        let path = NSBezierPath(roundedRect: rect, xRadius: mark.size, yRadius: mark.size)
        path.lineWidth = mark.size
        path.stroke()
      case .arrow:
        let angle = atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x)
        let head = arrowHead(mark.size)
        let base = CGPoint(
          x: mark.to.x - cos(angle) * head * 0.8, y: mark.to.y - sin(angle) * head * 0.8)
        let line = NSBezierPath()
        line.move(to: mark.from)
        line.line(to: base)
        line.lineWidth = mark.size
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
        NSBezierPath(rect: rect.intersection(imageRect)).addClip()
        coarse.draw(in: imageRect)
        NSGraphicsContext.current?.imageInterpolation = interpolation
        NSGraphicsContext.restoreGraphicsState()
      case .text:
        let text = NSAttributedString(string: mark.text, attributes: textAttributes(mark.color, size: mark.size))
        text.draw(at: CGPoint(x: mark.from.x, y: mark.from.y - text.size().height))
      case .number:
        let r = markerRadius(mark.size)
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
    // Outside the result: the window's background a shade darker.
    NSColor.black.withAlphaComponent(0.1).setFill()
    bounds.fill()
    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.translateX(by: -origin.x, yBy: -origin.y)
    transform.concat()
    // Where marks reach past the picture, the result is white.
    NSColor.white.setFill()
    resultRect.fill()
    image.draw(in: imageRect)
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
      marks.append(Mark(tool: .number, color: color, size: textSize, from: p, to: p, number: next))
      refit()
    default:
      drawing = Mark(tool: tool, color: color, size: lineWidth, from: p, to: p)
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
      if hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) > mark.size * 2 { marks.append(mark) }
    }
    drawing = nil
    refit()
  }

  /// The field's font: the text's size as it is drawn at this zoom.
  var fieldFont: NSFont { NSFont.boldSystemFont(ofSize: max(9, textSize * scale)) }

  func beginText(at p: CGPoint) {
    let box = NSTextField(frame: .zero)
    box.font = fieldFont
    box.textColor = color
    box.isBordered = false
    box.isBezeled = false
    box.drawsBackground = false
    box.focusRingType = .none
    box.placeholderString = "文字"
    box.cell?.wraps = false
    box.cell?.isScrollable = true
    box.wantsLayer = true
    box.layer?.borderWidth = 1.5
    box.layer?.borderColor = NSColor.controlAccentColor.cgColor
    box.layer?.cornerRadius = 4
    box.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.55).cgColor
    box.delegate = self
    addSubview(box)
    field = box
    fieldAnchor = p
    placeField()
    window?.makeFirstResponder(box)
  }

  /// Sizes the field to what is typed (a few letters' room at least) and
  /// puts its text's top-left corner on the anchor, as the mark will be drawn.
  func placeField() {
    guard let box = field else { return }
    let font = fieldFont
    let typed = box.stringValue.isEmpty ? "文字" : box.stringValue
    let width = (typed as NSString).size(withAttributes: [.font: font]).width
    let height = ceil(font.ascender - font.descender + font.leading) + 6
    let at = toView(fieldAnchor)
    box.frame = NSRect(
      x: (at.x - 5).rounded(), y: (at.y - height + 3).rounded(),
      width: ceil(width + font.pointSize * 1.2 + 10), height: height)
  }

  func controlTextDidChange(_ notification: Notification) {
    placeField()
  }

  /// Turns the text being typed into a mark (nothing when it is empty).
  func commitText() {
    guard let box = field else { return }
    field = nil
    let text = box.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      marks.append(
        Mark(tool: .text, color: box.textColor ?? color, size: textSize, from: fieldAnchor, to: fieldAnchor, text: text))
    }
    box.removeFromSuperview()
    window?.makeFirstResponder(self)
    refit()
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
    refit()
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

  func pickLevel(_ index: Int) {
    level = min(max(index, 0), lineSizes.count - 1)
    field?.font = fieldFont
    placeField()
    onLevel(level)
  }

  override func keyDown(with event: NSEvent) {
    let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
    if event.modifierFlags.contains(.command) && key == "z" { return undo() }
    if event.keyCode == 36 || event.keyCode == 76 { return onDone() }
    if event.keyCode == 53 { return onSkip() }
    if key == "[" { return pickLevel(level - 1) }
    if key == "]" { return pickLevel(level + 1) }
    if let next = Tool.allCases.first(where: { $0.key == key }) { return pick(next) }
    if let digit = Int(key), (1...palette.count).contains(digit) { return pickColor(digit - 1) }
    super.keyDown(with: event)
  }

  /// The picture with the marks drawn on it, as PNG: the picture's own size,
  /// grown on white to hold marks that reach past it.
  func png() -> Data? {
    commitText()
    let rect = resultRect
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(rect.width), pixelsHigh: Int(rect.height), bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }
    rep.size = rect.size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let transform = NSAffineTransform()
    transform.translateX(by: -rect.minX, yBy: -rect.minY)
    transform.concat()
    NSColor.white.setFill()
    rect.fill()
    image.draw(in: imageRect)
    drawMarks()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
  }
}

/// The window's content: the tool bar along the top and the canvas filling
/// the rest, whatever size the window is.
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
    canvas.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(1, bounds.height - barHeight))
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

/// A size's button: a short line as thick as the level, scaled to fit.
func thickness(_ level: Int) -> NSImage {
  let image = NSImage(size: NSSize(width: 18, height: 14), flipped: false) { rect in
    let height = 1 + CGFloat(level) * 1.25
    NSColor.black.setFill()
    NSBezierPath(
      roundedRect: NSRect(x: 2, y: (rect.height - height) / 2, width: rect.width - 4, height: height),
      xRadius: height / 2, yRadius: height / 2
    ).fill()
    return true
  }
  // A template follows the control's own color, light or dark, selected or not.
  image.isTemplate = true
  return image
}

func toolImage(_ tool: Tool) -> NSImage {
  if let image = NSImage(systemSymbolName: tool.symbol, accessibilityDescription: tool.label) {
    return image
  }
  // No such symbol on this system: the tool's name, drawn.
  let text = NSAttributedString(string: tool.label, attributes: [.font: NSFont.systemFont(ofSize: 11)])
  let image = NSImage(size: text.size(), flipped: false) { _ in
    text.draw(at: .zero)
    return true
  }
  image.isTemplate = true
  return image
}

final class Editor: NSObject, NSWindowDelegate {
  static let minSize = NSSize(width: 700, height: 360)
  let output: URL
  let terminal: pid_t
  let canvas: Canvas
  let panel: NSPanel
  let tools: NSSegmentedControl
  let colors: NSSegmentedControl
  let levels: NSSegmentedControl
  var isFinished = false

  init(input: URL, output: URL, title: String) {
    self.output = output
    terminal = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0

    guard let data = try? Data(contentsOf: input),
      let rep = NSBitmapImageRep(data: data),
      let image = NSImage(data: data)
    else { fail("cannot read \(input.path)") }
    let pixels = NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    let screen = NSScreen.main ?? NSScreen.screens[0]
    let canvas = Canvas(image: image, pixels: pixels, screenScale: screen.backingScaleFactor)
    self.canvas = canvas

    // The last size the person left the window at; else the view at its
    // size on a Retina screen. Either way within the screen.
    let room = screen.visibleFrame.insetBy(dx: 40, dy: 40).size
    let shown = canvas.shown.size
    var size = savedSize() ?? {
      let natural = NSSize(
        width: shown.width / screen.backingScaleFactor, height: shown.height / screen.backingScaleFactor)
      let fit = min(1, room.width / natural.width, (room.height - Container.barHeight) / natural.height)
      return NSSize(width: natural.width * fit, height: natural.height * fit + Container.barHeight)
    }()
    size.width = min(max(size.width, Editor.minSize.width), room.width)
    size.height = min(max(size.height, Editor.minSize.height), room.height)

    tools = NSSegmentedControl(
      images: Tool.allCases.map(toolImage), trackingMode: .selectOne, target: nil, action: nil)
    colors = NSSegmentedControl(
      images: palette.map(swatch), trackingMode: .selectOne, target: nil, action: nil)
    levels = NSSegmentedControl(
      images: lineSizes.indices.map(thickness), trackingMode: .selectOne, target: nil, action: nil)
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
    for index in lineSizes.indices {
      levels.setToolTip("粗細 \(index + 1)（[ 與 ] 調整）", forSegment: index)
    }
    tools.selectedSegment = 0
    tools.target = self
    tools.action = #selector(pickTool)
    colors.selectedSegment = 0
    colors.target = self
    colors.action = #selector(pickColor)
    levels.selectedSegment = defaultSize
    levels.target = self
    levels.action = #selector(pickLevel)
    let undo = NSButton(title: "復原", target: self, action: #selector(undoMark))
    undo.toolTip = "⌘Z"
    let skip = NSButton(title: "略過", target: self, action: #selector(skip))
    skip.toolTip = "Esc"
    let done = NSButton(title: "完成", target: self, action: #selector(done))
    done.toolTip = "Enter"
    done.bezelColor = .controlAccentColor
    let spacer = NSView()
    spacer.setContentHuggingPriority(.init(1), for: .horizontal)
    let bar = NSStackView(views: [tools, colors, levels, undo, spacer, skip, done])
    bar.orientation = .horizontal
    bar.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)

    canvas.onDone = { [unowned self] in self.done() }
    canvas.onSkip = { [unowned self] in self.skip() }
    canvas.onTool = { [unowned self] tool in self.tools.selectedSegment = tool.rawValue }
    canvas.onColor = { [unowned self] index in self.colors.selectedSegment = index }
    canvas.onLevel = { [unowned self] index in self.levels.selectedSegment = index }

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

  @objc func pickLevel() {
    canvas.pickLevel(max(0, levels.selectedSegment))
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

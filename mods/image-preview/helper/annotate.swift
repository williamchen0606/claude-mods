// The image-preview mod's annotation window (macOS only), built by the mod
// with `swiftc` the first time it is needed.
//
//   annotate edit <in.png> <out.png> <title>
//     Opens a window over <in.png> to mark it up: select, rectangle,
//     ellipse, line, arrow, text, mosaic, highlighter, pen and numbered
//     markers, in eight colors and five sizes, outlined or filled. A mark
//     can be selected to move it, resize it or restyle it. Marks may reach
//     past the picture: the result grows to hold them, on white. Done
//     writes <out.png> and prints `saved <pid>`, the pid being the app that
//     was in front when the window opened (the terminal). Skip, or closing
//     the window, prints `skipped`. The window's size is kept for the next.
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

// MARK: - The marks

enum Tool: Int, CaseIterable {
  case select = 0
  case rectangle
  case ellipse
  case line
  case arrow
  case text
  case mosaic
  case highlighter
  case pen
  case number

  var label: String {
    switch self {
    case .select: return "選取"
    case .rectangle: return "矩形"
    case .ellipse: return "橢圓"
    case .line: return "直線"
    case .arrow: return "箭頭"
    case .text: return "文字"
    case .mosaic: return "馬賽克"
    case .highlighter: return "螢光筆"
    case .pen: return "畫筆"
    case .number: return "編號"
    }
  }

  var key: String {
    switch self {
    case .select: return "v"
    case .rectangle: return "r"
    case .ellipse: return "o"
    case .line: return "l"
    case .arrow: return "a"
    case .text: return "t"
    case .mosaic: return "m"
    case .highlighter: return "h"
    case .pen: return "p"
    case .number: return "n"
    }
  }

  /// The SF Symbol drawn on the tool's button.
  var symbol: String {
    switch self {
    case .select: return "cursorarrow"
    case .rectangle: return "rectangle"
    case .ellipse: return "circle"
    case .line: return "line.diagonal"
    case .arrow: return "arrow.up.right"
    case .text: return "textformat"
    case .mosaic: return "square.grid.3x3.fill"
    case .highlighter: return "highlighter"
    case .pen: return "scribble"
    case .number: return "1.circle"
    }
  }

  /// A mark drawn along the pointer's path, kept as its points.
  var isPath: Bool { self == .pen || self == .highlighter }
}

/// The colors, picked with the keys 1 to 8.
let palette: [NSColor] = [
  .systemRed, .systemOrange, .systemYellow, .systemGreen, .systemBlue, .systemPurple, .black, .white,
]
let colorNames = ["紅", "橘", "黃", "綠", "藍", "紫", "黑", "白"]

/// The five sizes, in points: a line's width and a text's size at each.
let lineSizes: [CGFloat] = [2, 3, 4.5, 6, 8]
let textSizes: [CGFloat] = [14, 18, 24, 30, 38]
let defaultLevel = 2

/// How the next mark is drawn, and how the selected one is.
struct Style {
  var color: NSColor = palette[0]
  var level = defaultLevel
  var isFilled = false
}

/// One mark, in the image's pixels, origin at the image's bottom left; it may
/// lie past the image's edges.
struct Mark {
  var tool: Tool
  var style: Style
  var from: CGPoint
  var to: CGPoint
  /// A pen or highlighter's path.
  var points: [CGPoint] = []
  var text = ""
  /// A text's wrapping width; nil keeps it on one line.
  var width: CGFloat?
  var number = 0
}

/// The text color that reads on `color`: black on light colors, else white.
func contrast(_ color: NSColor) -> NSColor {
  guard let c = color.usingColorSpace(.sRGB) else { return .white }
  let luma = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
  return luma > 0.6 ? .black : .white
}

func distance(_ p: CGPoint, toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
  let dx = b.x - a.x
  let dy = b.y - a.y
  let length = dx * dx + dy * dy
  guard length > 0 else { return hypot(p.x - a.x, p.y - a.y) }
  let t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length))
  return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

func box(_ a: CGPoint, _ b: CGPoint) -> NSRect {
  NSRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
}

func polyline(_ points: [CGPoint]) -> NSBezierPath {
  let path = NSBezierPath()
  guard let first = points.first else { return path }
  path.move(to: first)
  for p in points.dropFirst() { path.line(to: p) }
  if points.count == 1 { path.line(to: CGPoint(x: first.x + 0.1, y: first.y)) }
  path.lineCapStyle = .round
  path.lineJoinStyle = .round
  return path
}

// MARK: - The canvas

/// What a drag in the canvas is doing.
enum Drag {
  case none
  case drawing
  case moving(from: CGPoint, original: Mark)
  case handle(Int, original: Mark)
}

final class Canvas: NSView, NSTextFieldDelegate {
  let image: NSImage
  let pixels: NSSize
  /// Image pixels per point: the screen's, more for a large picture, so
  /// sizes read the same on any image.
  let unit: CGFloat
  let screenScale: CGFloat
  /// The image coarsened into blocks, drawn through a mosaic mark's rect.
  let coarse: NSImage
  var marks: [Mark] = []
  var history: [[Mark]] = []
  var future: [[Mark]] = []
  var drawing: Mark?
  var drag = Drag.none
  /// Whether the drag under way has been put on the undo history yet.
  var isRecorded = false
  var selected: Int?
  var tool: Tool = .rectangle
  var style = Style()
  var field: NSTextField?
  /// The text mark the field is editing, hidden meanwhile; nil for a new one.
  var editing: Int?
  var fieldAnchor = CGPoint.zero
  var fieldWidth: CGFloat?
  /// The part of the image plane in view, in image pixels: the result with
  /// room around it. Settled between strokes, not during one.
  var shown = NSRect.zero
  var onDone: () -> Void = {}
  var onSkip: () -> Void = {}
  /// The tool, the style or the selection changed: the toolbar follows.
  var onChange: () -> Void = {}
  var onZoom: (Int) -> Void = { _ in }

  init(image: NSImage, pixels: NSSize, screenScale: CGFloat) {
    self.image = image
    self.pixels = pixels
    self.screenScale = screenScale
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
  func lineWidth(_ level: Int) -> CGFloat { lineSizes[level] * unit }
  func textSize(_ level: Int) -> CGFloat { textSizes[level] * unit }
  func arrowHead(_ level: Int) -> CGFloat { max(lineWidth(level) * 3.6, 9 * unit) }
  func markerRadius(_ level: Int) -> CGFloat { textSize(level) * 0.62 }

  var selectedMark: Mark? {
    guard let s = selected, s < marks.count else { return nil }
    return marks[s]
  }

  // MARK: Where things are

  /// How many view points one image pixel takes.
  var scale: CGFloat {
    guard shown.width > 0, shown.height > 0, bounds.width > 0, bounds.height > 0 else { return 1 }
    return min(bounds.width / shown.width, bounds.height / shown.height)
  }

  /// The image point drawn at the view's bottom-left corner, `shown` centered.
  var origin: CGPoint {
    CGPoint(x: shown.midX - bounds.width / scale / 2, y: shown.midY - bounds.height / scale / 2)
  }

  func toImage(_ event: NSEvent) -> CGPoint {
    let p = convert(event.locationInWindow, from: nil)
    return CGPoint(x: p.x / scale + origin.x, y: p.y / scale + origin.y)
  }

  func toView(_ p: CGPoint) -> CGPoint {
    CGPoint(x: (p.x - origin.x) * scale, y: (p.y - origin.y) * scale)
  }

  func toView(_ r: NSRect) -> NSRect {
    let a = toView(CGPoint(x: r.minX, y: r.minY))
    return NSRect(x: a.x, y: a.y, width: r.width * scale, height: r.height * scale)
  }

  func textString(_ m: Mark) -> NSAttributedString {
    var attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: textSize(m.style.level), weight: .bold)
    ]
    if m.style.isFilled {
      attributes[.foregroundColor] = contrast(m.style.color)
    } else {
      // A negative stroke width fills and outlines, so the text reads on any background.
      attributes[.foregroundColor] = m.style.color
      attributes[.strokeColor] = contrast(m.style.color).withAlphaComponent(0.7)
      attributes[.strokeWidth] = -3.0
    }
    return NSAttributedString(string: m.text.isEmpty ? " " : m.text, attributes: attributes)
  }

  /// Where a text mark's letters go: its top-left corner on `from`.
  func textRect(_ m: Mark) -> NSRect {
    let text = textString(m)
    var size: NSSize
    if let width = m.width {
      let fitted = text.boundingRect(
        with: NSSize(width: width, height: 100_000), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
      size = NSSize(width: width, height: ceil(fitted.height))
    } else {
      size = text.size()
      size = NSSize(width: ceil(size.width), height: ceil(size.height))
    }
    return NSRect(x: m.from.x, y: m.from.y - size.height, width: size.width, height: size.height)
  }

  func textPad(_ m: Mark) -> NSSize {
    let size = textSize(m.style.level)
    return m.style.isFilled ? NSSize(width: size * 0.4, height: size * 0.2) : .zero
  }

  /// A mark's own extent: its box, its path's, its text's or its marker's.
  func extent(_ m: Mark) -> NSRect {
    switch m.tool {
    case .pen, .highlighter:
      return m.points.dropFirst().reduce(box(m.points.first ?? m.from, m.points.first ?? m.from)) {
        $0.union(box($1, $1))
      }
    case .text:
      let pad = textPad(m)
      return textRect(m).insetBy(dx: -pad.width, dy: -pad.height)
    case .number:
      let r = markerRadius(m.style.level)
      return NSRect(x: m.from.x - r, y: m.from.y - r, width: r * 2, height: r * 2)
    default:
      return box(m.from, m.to)
    }
  }

  /// What a mark covers, to grow the result by; a mosaic only ever covers
  /// the picture, so it grows nothing.
  func cover(_ m: Mark) -> NSRect {
    let b = extent(m)
    switch m.tool {
    case .mosaic, .select: return .null
    case .line, .arrow: return b.insetBy(dx: -arrowHead(m.style.level), dy: -arrowHead(m.style.level))
    case .highlighter: return b.insetBy(dx: -lineWidth(m.style.level) * 2.5, dy: -lineWidth(m.style.level) * 2.5)
    case .text, .number: return b
    default: return b.insetBy(dx: -lineWidth(m.style.level), dy: -lineWidth(m.style.level))
    }
  }

  /// The result's bounds: the picture and every mark, whole pixels.
  var resultRect: NSRect {
    NSIntegralRect(marks.reduce(imageRect) { $0.union(cover($1)) })
  }

  /// Settles what the view shows: the result with room around it to draw in.
  func refit() {
    let rect = resultRect
    let room = max(48 * unit, max(rect.width, rect.height) * 0.08)
    shown = rect.insetBy(dx: -room, dy: -room)
    needsDisplay = true
    onZoom(Int((scale * screenScale * 100).rounded()))
  }

  /// Whether `p` lands on the mark, `tolerance` image pixels around it.
  func hit(_ m: Mark, _ p: CGPoint, tolerance: CGFloat) -> Bool {
    let reach = tolerance + lineWidth(m.style.level) / 2
    switch m.tool {
    case .line, .arrow:
      return distance(p, toSegment: m.from, m.to) <= reach
    case .pen, .highlighter:
      let width = m.tool == .highlighter ? reach + lineWidth(m.style.level) * 2 : reach
      if m.points.count < 2 { return hypot(p.x - m.from.x, p.y - m.from.y) <= width }
      return zip(m.points, m.points.dropFirst()).contains { distance(p, toSegment: $0, $1) <= width }
    default:
      return extent(m).insetBy(dx: -tolerance, dy: -tolerance).contains(p)
    }
  }

  /// The points a selected mark is reshaped by.
  func handles(_ m: Mark) -> [CGPoint] {
    switch m.tool {
    case .line, .arrow:
      return [m.from, m.to]
    case .text:
      let b = extent(m)
      return [CGPoint(x: b.maxX, y: b.midY)]
    case .number, .select:
      return []
    default:
      let b = extent(m)
      return [
        CGPoint(x: b.minX, y: b.minY), CGPoint(x: b.maxX, y: b.minY),
        CGPoint(x: b.maxX, y: b.maxY), CGPoint(x: b.minX, y: b.maxY),
      ]
    }
  }

  func moved(_ m: Mark, by dx: CGFloat, _ dy: CGFloat) -> Mark {
    var m = m
    m.from = CGPoint(x: m.from.x + dx, y: m.from.y + dy)
    m.to = CGPoint(x: m.to.x + dx, y: m.to.y + dy)
    m.points = m.points.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
    return m
  }

  /// `original` with its handle `index` dragged to `p`.
  func reshaped(_ original: Mark, handle index: Int, to p: CGPoint) -> Mark {
    var m = original
    switch m.tool {
    case .line, .arrow:
      if index == 0 { m.from = p } else { m.to = p }
    case .text:
      let b = textRect(original)
      let pad = textPad(original)
      m.width = max(textSize(m.style.level) * 1.5, p.x - pad.width - b.minX)
    default:
      let corners = handles(original)
      guard index < corners.count else { return m }
      let fixed = corners[(index + 2) % 4]
      let moving = corners[index]
      if m.tool.isPath {
        // Scale the path from the fixed corner, as its box is reshaped.
        let sx = moving.x == fixed.x ? 1 : (p.x - fixed.x) / (moving.x - fixed.x)
        let sy = moving.y == fixed.y ? 1 : (p.y - fixed.y) / (moving.y - fixed.y)
        m.points = original.points.map {
          CGPoint(x: fixed.x + ($0.x - fixed.x) * sx, y: fixed.y + ($0.y - fixed.y) * sy)
        }
      } else {
        m.from = fixed
        m.to = p
      }
    }
    return m
  }

  /// With Shift: boxes square, lines at the nearest 45 degrees.
  func constrained(_ from: CGPoint, _ to: CGPoint, tool: Tool) -> CGPoint {
    let dx = to.x - from.x
    let dy = to.y - from.y
    switch tool {
    case .rectangle, .ellipse, .mosaic:
      let d = max(abs(dx), abs(dy))
      return CGPoint(x: from.x + (dx < 0 ? -d : d), y: from.y + (dy < 0 ? -d : d))
    case .line, .arrow:
      let step = CGFloat.pi / 4
      let angle = (atan2(dy, dx) / step).rounded() * step
      let length = hypot(dx, dy)
      return CGPoint(x: from.x + cos(angle) * length, y: from.y + sin(angle) * length)
    default:
      return to
    }
  }

  // MARK: Drawing

  func paint(_ m: Mark) {
    let width = lineWidth(m.style.level)
    let color = m.style.color
    color.setStroke()
    color.setFill()
    let rect = box(m.from, m.to)
    switch m.tool {
    case .select:
      break
    case .rectangle:
      let path = NSBezierPath(roundedRect: rect, xRadius: width, yRadius: width)
      if m.style.isFilled {
        path.fill()
      } else {
        path.lineWidth = width
        path.stroke()
      }
    case .ellipse:
      let path = NSBezierPath(ovalIn: rect)
      if m.style.isFilled {
        path.fill()
      } else {
        path.lineWidth = width
        path.stroke()
      }
    case .line:
      let path = polyline([m.from, m.to])
      path.lineWidth = width
      path.stroke()
    case .arrow:
      let angle = atan2(m.to.y - m.from.y, m.to.x - m.from.x)
      let head = arrowHead(m.style.level)
      let base = CGPoint(x: m.to.x - cos(angle) * head * 0.75, y: m.to.y - sin(angle) * head * 0.75)
      let shaft = polyline([m.from, base])
      shaft.lineWidth = width
      shaft.stroke()
      let tip = NSBezierPath()
      tip.move(to: m.to)
      tip.line(to: CGPoint(x: m.to.x - cos(angle - 0.42) * head, y: m.to.y - sin(angle - 0.42) * head))
      tip.line(to: CGPoint(x: m.to.x - cos(angle + 0.42) * head, y: m.to.y - sin(angle + 0.42) * head))
      tip.close()
      tip.lineJoinStyle = .round
      tip.lineWidth = width * 0.6
      tip.fill()
      tip.stroke()
    case .mosaic:
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current?.imageInterpolation = .none
      NSBezierPath(rect: rect.intersection(imageRect)).addClip()
      coarse.draw(in: imageRect)
      NSGraphicsContext.restoreGraphicsState()
    case .highlighter:
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current?.compositingOperation = .multiply
      color.withAlphaComponent(0.45).setStroke()
      let path = polyline(m.points)
      path.lineWidth = width * 4
      path.lineCapStyle = .square
      path.stroke()
      NSGraphicsContext.restoreGraphicsState()
    case .pen:
      let path = polyline(m.points)
      path.lineWidth = width
      path.stroke()
    case .text:
      if m.style.isFilled {
        let pad = textPad(m)
        let back = textRect(m).insetBy(dx: -pad.width, dy: -pad.height)
        NSBezierPath(roundedRect: back, xRadius: pad.width * 0.8, yRadius: pad.width * 0.8).fill()
      }
      textString(m).draw(with: textRect(m), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    case .number:
      let r = markerRadius(m.style.level)
      let disc = NSBezierPath(ovalIn: NSRect(x: m.from.x - r, y: m.from.y - r, width: r * 2, height: r * 2))
      disc.fill()
      contrast(color).withAlphaComponent(0.9).setStroke()
      disc.lineWidth = max(1, r * 0.1)
      disc.stroke()
      let digits = NSAttributedString(
        string: String(m.number),
        attributes: [
          .font: NSFont.systemFont(ofSize: r * 1.15, weight: .bold), .foregroundColor: contrast(color),
        ])
      let size = digits.size()
      digits.draw(at: CGPoint(x: m.from.x - size.width / 2, y: m.from.y - size.height / 2))
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    // Outside the result: the window's background a shade darker.
    NSColor.black.withAlphaComponent(0.1).setFill()
    NSBezierPath(rect: bounds).fill()

    let result = resultRect
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
    shadow.shadowBlurRadius = 14
    shadow.shadowOffset = NSSize(width: 0, height: -3)
    shadow.set()
    NSColor.white.setFill()
    NSBezierPath(rect: toView(result)).fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.translateX(by: -origin.x, yBy: -origin.y)
    transform.concat()
    image.draw(in: imageRect)
    for (index, mark) in marks.enumerated() where index != editing { paint(mark) }
    if let m = drawing { paint(m) }
    NSGraphicsContext.restoreGraphicsState()

    drawSelection()
  }

  /// The selected mark's frame and handles, in view points over the drawing.
  func drawSelection() {
    guard let m = selectedMark, selected != editing else { return }
    let accent = NSColor.controlAccentColor
    if m.tool != .line && m.tool != .arrow {
      let frame = NSBezierPath(rect: toView(extent(m)).insetBy(dx: -4, dy: -4))
      let dash: [CGFloat] = [4, 3]
      frame.setLineDash(dash, count: 2, phase: 0)
      frame.lineWidth = 1
      accent.setStroke()
      frame.stroke()
    }
    for handle in handles(m) {
      let c = toView(handle)
      let dot = NSBezierPath(ovalIn: NSRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10))
      NSColor.white.setFill()
      dot.fill()
      dot.lineWidth = 1.5
      accent.setStroke()
      dot.stroke()
    }
  }

  override func setFrameSize(_ newSize: NSSize) {
    // A text being typed is placed in view points; settle it before they change.
    commitText()
    super.setFrameSize(newSize)
    onZoom(Int((scale * screenScale * 100).rounded()))
  }

  // MARK: Pointer

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect, .cursorUpdate],
        owner: self, userInfo: nil))
  }

  func nearHandle(_ p: CGPoint) -> Int? {
    guard let m = selectedMark else { return nil }
    let reach = 8 / scale
    return handles(m).firstIndex { hypot($0.x - p.x, $0.y - p.y) <= reach }
  }

  func topMark(at p: CGPoint) -> Int? {
    marks.indices.reversed().first { hit(marks[$0], p, tolerance: 5 / scale) }
  }

  func cursor(at p: CGPoint) -> NSCursor {
    if nearHandle(p) != nil { return .crosshair }
    switch tool {
    case .select: return topMark(at: p) == nil ? .arrow : .openHand
    case .text: return .iBeam
    default: return .crosshair
    }
  }

  override func mouseMoved(with event: NSEvent) {
    cursor(at: toImage(event)).set()
  }

  override func cursorUpdate(with event: NSEvent) {
    cursor(at: toImage(event)).set()
  }

  override func mouseDown(with event: NSEvent) {
    let wasTyping = field != nil
    commitText()
    let p = toImage(event)

    // A handle of the selected mark reshapes it, whatever the tool.
    if let index = nearHandle(p), let m = selectedMark {
      drag = .handle(index, original: m)
      isRecorded = false
      return
    }

    if tool == .select {
      if let index = topMark(at: p) {
        selected = index
        style = marks[index].style
        if event.clickCount == 2 && marks[index].tool == .text {
          beginText(editing: index)
        } else {
          drag = .moving(from: p, original: marks[index])
          isRecorded = false
          NSCursor.closedHand.set()
        }
      } else {
        selected = nil
      }
      needsDisplay = true
      onChange()
      return
    }

    selected = nil
    switch tool {
    case .text:
      if let index = marks.indices.reversed().first(where: {
        marks[$0].tool == .text && hit(marks[$0], p, tolerance: 0)
      }) {
        selected = index
        style = marks[index].style
        beginText(editing: index)
      } else if !wasTyping {
        beginText(at: p)
      }
    case .number:
      record()
      let next = (marks.filter { $0.tool == .number }.map(\.number).max() ?? 0) + 1
      marks.append(Mark(tool: .number, style: style, from: p, to: p, number: next))
      selected = marks.count - 1
      refit()
    default:
      drawing = Mark(tool: tool, style: style, from: p, to: p, points: tool.isPath ? [p] : [])
      drag = .drawing
    }
    needsDisplay = true
    onChange()
  }

  override func mouseDragged(with event: NSEvent) {
    var p = toImage(event)
    let isShift = event.modifierFlags.contains(.shift)
    switch drag {
    case .none:
      return
    case .drawing:
      guard var m = drawing else { return }
      if m.tool.isPath {
        m.points.append(p)
      } else {
        m.to = isShift ? constrained(m.from, p, tool: m.tool) : p
      }
      drawing = m
    case .moving(let start, let original):
      guard let s = selected else { return }
      if !isRecorded {
        record()
        isRecorded = true
      }
      marks[s] = moved(original, by: p.x - start.x, p.y - start.y)
    case .handle(let index, let original):
      guard let s = selected else { return }
      if !isRecorded {
        record()
        isRecorded = true
      }
      if isShift && (original.tool == .line || original.tool == .arrow) {
        p = constrained(index == 0 ? original.to : original.from, p, tool: original.tool)
      }
      marks[s] = reshaped(original, handle: index, to: p)
    }
    needsDisplay = true
  }

  override func mouseUp(with event: NSEvent) {
    if case .drawing = drag, let m = drawing {
      let isBigEnough =
        m.tool.isPath ? m.points.count > 2 : hypot(m.to.x - m.from.x, m.to.y - m.from.y) > 4 / scale
      if isBigEnough {
        record()
        marks.append(m)
        selected = marks.count - 1
      }
    }
    drawing = nil
    drag = .none
    refit()
    onChange()
    cursor(at: toImage(event)).set()
  }

  // MARK: Text

  /// The field's font: the text's size as it is drawn at this zoom.
  var fieldFont: NSFont { NSFont.systemFont(ofSize: max(10, textSize(style.level) * scale), weight: .bold) }

  func beginText(at p: CGPoint) {
    startField(anchor: p, text: "", width: nil, editing: nil)
  }

  func beginText(editing index: Int) {
    let m = marks[index]
    startField(anchor: m.from, text: m.text, width: m.width, editing: index)
  }

  func startField(anchor: CGPoint, text: String, width: CGFloat?, editing index: Int?) {
    let input = NSTextField(frame: .zero)
    input.stringValue = text
    input.isBordered = false
    input.isBezeled = false
    input.drawsBackground = false
    input.focusRingType = .none
    input.placeholderString = "輸入文字"
    input.cell?.wraps = false
    input.cell?.isScrollable = true
    input.wantsLayer = true
    input.layer?.cornerRadius = 6
    input.layer?.borderWidth = 1.5
    input.delegate = self
    addSubview(input)
    field = input
    editing = index
    fieldAnchor = anchor
    fieldWidth = width
    styleField()
    window?.makeFirstResponder(input)
    needsDisplay = true
  }

  /// Dresses the field as the mark will look: its color, size and fill.
  func styleField() {
    guard let input = field else { return }
    input.font = fieldFont
    input.textColor = style.isFilled ? contrast(style.color) : style.color
    input.layer?.borderColor = NSColor.controlAccentColor.cgColor
    input.layer?.backgroundColor =
      style.isFilled
      ? style.color.cgColor
      : contrast(style.color).withAlphaComponent(0.35).cgColor
    placeField()
  }

  /// Sizes the field to what is typed (or to the mark's width) and puts the
  /// text's top-left corner on the anchor, where the mark will draw it.
  func placeField() {
    guard let input = field else { return }
    let font = fieldFont
    let typed = input.stringValue.isEmpty ? "輸入文字" : input.stringValue
    let natural = (typed as NSString).size(withAttributes: [.font: font]).width
    let width = fieldWidth.map { $0 * scale } ?? natural
    let height = ceil(font.ascender - font.descender + font.leading) + 8
    let at = toView(fieldAnchor)
    input.frame = NSRect(
      x: (at.x - 6).rounded(), y: (at.y - height + 4).rounded(),
      width: ceil(width + font.pointSize * 0.8 + 12), height: height)
  }

  func controlTextDidChange(_ notification: Notification) {
    placeField()
  }

  /// Turns the text being typed into a mark (an emptied one is removed).
  func commitText() {
    guard let input = field else { return }
    field = nil
    let text = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if let index = editing, index < marks.count {
      record()
      if text.isEmpty {
        marks.remove(at: index)
        selected = nil
      } else {
        marks[index].text = text
        marks[index].style = style
        selected = index
      }
    } else if !text.isEmpty {
      record()
      marks.append(
        Mark(tool: .text, style: style, from: fieldAnchor, to: fieldAnchor, text: text, width: fieldWidth))
      selected = marks.count - 1
    }
    editing = nil
    input.removeFromSuperview()
    window?.makeFirstResponder(self)
    refit()
    onChange()
  }

  /// Drops the field and what was typed in it; a text being edited stays as it was.
  func cancelText() {
    guard let input = field else { return }
    field = nil
    editing = nil
    input.removeFromSuperview()
    window?.makeFirstResponder(self)
    needsDisplay = true
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

  // MARK: Editing

  func record() {
    history.append(marks)
    if history.count > 200 { history.removeFirst() }
    future.removeAll()
  }

  var canUndo: Bool { !history.isEmpty }
  var canRedo: Bool { !future.isEmpty }

  func undo() {
    if field != nil { return cancelText() }
    guard let last = history.popLast() else { return }
    future.append(marks)
    marks = last
    selected = nil
    refit()
    onChange()
  }

  func redo() {
    guard let next = future.popLast() else { return }
    history.append(marks)
    marks = next
    selected = nil
    refit()
    onChange()
  }

  func deleteSelected() {
    guard let s = selected, s < marks.count else { return }
    record()
    marks.remove(at: s)
    selected = nil
    refit()
    onChange()
  }

  func nudge(_ dx: CGFloat, _ dy: CGFloat) {
    guard let s = selected, s < marks.count else { return }
    record()
    marks[s] = moved(marks[s], by: dx, dy)
    refit()
  }

  /// Changes the style for what comes next, and for the selected mark.
  func restyle(_ change: (inout Style) -> Void) {
    change(&style)
    if field != nil {
      styleField()
    } else if let s = selected, s < marks.count {
      record()
      change(&marks[s].style)
      refit()
    }
    onChange()
  }

  func pick(_ next: Tool) {
    commitText()
    tool = next
    if next != .select { selected = nil }
    needsDisplay = true
    onChange()
  }

  override func keyDown(with event: NSEvent) {
    let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
    let flags = event.modifierFlags
    if flags.contains(.command) {
      if key == "z" { return flags.contains(.shift) ? redo() : undo() }
      return super.keyDown(with: event)
    }
    let step: CGFloat = flags.contains(.shift) ? 10 * unit : unit
    switch event.keyCode {
    case 36, 76: return onDone()
    case 53:
      if selected != nil {
        selected = nil
        needsDisplay = true
        return onChange()
      }
      return onSkip()
    case 51, 117: return deleteSelected()
    case 123: return nudge(-step, 0)
    case 124: return nudge(step, 0)
    case 125: return nudge(0, -step)
    case 126: return nudge(0, step)
    default: break
    }
    if key == "[" { return restyle { $0.level = max(0, $0.level - 1) } }
    if key == "]" { return restyle { $0.level = min(lineSizes.count - 1, $0.level + 1) } }
    if key == "f" { return restyle { $0.isFilled.toggle() } }
    if let next = Tool.allCases.first(where: { $0.key == key }) { return pick(next) }
    if let digit = Int(key), (1...palette.count).contains(digit) {
      return restyle { $0.color = palette[digit - 1] }
    }
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
    NSBezierPath(rect: rect).fill()
    image.draw(in: imageRect)
    for mark in marks { paint(mark) }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
  }
}

// MARK: - Toolbar pieces

func symbol(_ name: String, _ label: String, size: CGFloat = 15) -> NSImage {
  if let base = NSImage(systemSymbolName: name, accessibilityDescription: label),
    let image = base.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: .medium))
  {
    image.isTemplate = true
    return image
  }
  // No such symbol on this system: the name, drawn.
  let text = NSAttributedString(string: label, attributes: [.font: NSFont.systemFont(ofSize: 11)])
  let image = NSImage(size: text.size(), flipped: false) { _ in
    text.draw(at: .zero)
    return true
  }
  image.isTemplate = true
  return image
}

/// A template image in `color`.
func tinted(_ image: NSImage, _ color: NSColor) -> NSImage {
  NSImage(size: image.size, flipped: false) { rect in
    image.draw(in: rect)
    color.set()
    rect.fill(using: .sourceAtop)
    return true
  }
}

func swatch(_ color: NSColor, side: CGFloat = 16) -> NSImage {
  NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
    let disc = NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1))
    color.setFill()
    disc.fill()
    NSColor.black.withAlphaComponent(0.18).setStroke()
    disc.lineWidth = 1
    disc.stroke()
    return true
  }
}

/// A size's picture: a short line as thick as the level.
func thickness(_ level: Int, width: CGFloat = 20) -> NSImage {
  let image = NSImage(size: NSSize(width: width, height: 16), flipped: false) { rect in
    let height = 1.5 + CGFloat(level) * 1.4
    NSColor.black.setFill()
    NSBezierPath(
      roundedRect: NSRect(x: 2, y: (rect.height - height) / 2, width: rect.width - 4, height: height),
      xRadius: height / 2, yRadius: height / 2
    ).fill()
    return true
  }
  image.isTemplate = true
  return image
}

/// A small downward chevron, for buttons that open a menu.
func chevron() -> NSImage {
  let image = NSImage(size: NSSize(width: 8, height: 5), flipped: false) { rect in
    let path = NSBezierPath()
    path.move(to: CGPoint(x: 0.75, y: rect.height - 0.75))
    path.line(to: CGPoint(x: rect.midX, y: 0.75))
    path.line(to: CGPoint(x: rect.width - 0.75, y: rect.height - 0.75))
    path.lineWidth = 1.5
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    NSColor.black.setStroke()
    path.stroke()
    return true
  }
  image.isTemplate = true
  return image
}

/// A borderless toolbar button: an icon, the accent fill when selected, a
/// faint one under the pointer, and its name as the tooltip.
final class IconButton: NSView {
  var image: NSImage { didSet { needsDisplay = true } }
  /// A second picture after the first, drawn dim: a menu's chevron.
  var trailing: NSImage?
  var isSelected = false { didSet { needsDisplay = true } }
  var isEnabled = true { didSet { needsDisplay = true } }
  var isHovered = false { didSet { needsDisplay = true } }
  var action: () -> Void

  init(image: NSImage, tip: String, width: CGFloat = 32, trailing: NSImage? = nil, action: @escaping () -> Void) {
    self.image = image
    self.trailing = trailing
    self.action = action
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: 28))
    toolTip = tip
    translatesAutoresizingMaskIntoConstraints = false
    widthAnchor.constraint(equalToConstant: width).isActive = true
    heightAnchor.constraint(equalToConstant: 28).isActive = true
  }

  required init?(coder: NSCoder) { fatalError() }

  override var mouseDownCanMoveWindow: Bool { false }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
  }

  override func mouseEntered(with event: NSEvent) { isHovered = true }
  override func mouseExited(with event: NSEvent) { isHovered = false }
  override func mouseDown(with event: NSEvent) {}

  override func mouseUp(with event: NSEvent) {
    if isEnabled && bounds.contains(convert(event.locationInWindow, from: nil)) { action() }
  }

  override func draw(_ dirtyRect: NSRect) {
    let plate = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7)
    if isSelected {
      NSColor.controlAccentColor.setFill()
      plate.fill()
    } else if isHovered && isEnabled {
      NSColor.labelColor.withAlphaComponent(0.08).setFill()
      plate.fill()
    }
    let tint: NSColor = isSelected ? .white : isEnabled ? .labelColor : .tertiaryLabelColor
    let main = image.isTemplate ? tinted(image, tint) : image
    let tail = trailing.map { tinted($0, isSelected ? .white : .secondaryLabelColor) }
    let gap: CGFloat = tail == nil ? 0 : 5
    let total = main.size.width + gap + (tail?.size.width ?? 0)
    var x = ((bounds.width - total) / 2).rounded()
    main.draw(in: NSRect(
      x: x, y: ((bounds.height - main.size.height) / 2).rounded(),
      width: main.size.width, height: main.size.height))
    x += main.size.width + gap
    if let tail {
      tail.draw(in: NSRect(
        x: x, y: ((bounds.height - tail.size.height) / 2).rounded(),
        width: tail.size.width, height: tail.size.height))
    }
  }
}

/// A capsule with a title: the accent-filled main action, or a quiet one.
final class CapsuleButton: NSView {
  let title: String
  let isPrimary: Bool
  var isHovered = false { didSet { needsDisplay = true } }
  var action: () -> Void

  init(title: String, tip: String, isPrimary: Bool, action: @escaping () -> Void) {
    self.title = title
    self.isPrimary = isPrimary
    self.action = action
    super.init(frame: .zero)
    toolTip = tip
    translatesAutoresizingMaskIntoConstraints = false
    let width = ceil((title as NSString).size(withAttributes: [.font: font]).width) + 30
    widthAnchor.constraint(equalToConstant: width).isActive = true
    heightAnchor.constraint(equalToConstant: 28).isActive = true
  }

  required init?(coder: NSCoder) { fatalError() }

  var font: NSFont { NSFont.systemFont(ofSize: 13, weight: isPrimary ? .semibold : .medium) }

  override var mouseDownCanMoveWindow: Bool { false }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
  }

  override func mouseEntered(with event: NSEvent) { isHovered = true }
  override func mouseExited(with event: NSEvent) { isHovered = false }
  override func mouseDown(with event: NSEvent) {}

  override func mouseUp(with event: NSEvent) {
    if bounds.contains(convert(event.locationInWindow, from: nil)) { action() }
  }

  override func draw(_ dirtyRect: NSRect) {
    let r = bounds.insetBy(dx: 1, dy: 1)
    let plate = NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2)
    let fill: NSColor =
      isPrimary
      ? NSColor.controlAccentColor.withAlphaComponent(isHovered ? 0.85 : 1)
      : NSColor.labelColor.withAlphaComponent(isHovered ? 0.12 : 0.06)
    fill.setFill()
    plate.fill()
    let text = NSAttributedString(
      string: title, attributes: [.font: font, .foregroundColor: isPrimary ? NSColor.white : NSColor.labelColor])
    let size = text.size()
    text.draw(at: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
  }
}

/// A rounded tray holding a row of buttons, as the toolbar groups them.
final class Tray: NSView {
  init(_ views: [NSView], spacing: CGFloat = 2) {
    super.init(frame: .zero)
    translatesAutoresizingMaskIntoConstraints = false
    let row = NSStackView(views: views)
    row.orientation = .horizontal
    row.spacing = spacing
    row.edgeInsets = NSEdgeInsets(top: 3, left: 3, bottom: 3, right: 3)
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: leadingAnchor),
      row.trailingAnchor.constraint(equalTo: trailingAnchor),
      row.topAnchor.constraint(equalTo: topAnchor),
      row.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError() }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.labelColor.withAlphaComponent(0.055).setFill()
    NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10).fill()
  }
}

func row(_ views: [NSView], spacing: CGFloat) -> NSStackView {
  let stack = NSStackView(views: views)
  stack.orientation = .horizontal
  stack.spacing = spacing
  stack.translatesAutoresizingMaskIntoConstraints = false
  return stack
}

func label(_ text: String) -> NSTextField {
  let field = NSTextField(labelWithString: text)
  field.font = NSFont.systemFont(ofSize: 11)
  field.textColor = .secondaryLabelColor
  field.lineBreakMode = .byTruncatingTail
  return field
}

// MARK: - The window

/// The window's content: the canvas, and a strip of hints and the zoom below.
final class Container: NSView {
  static let footHeight: CGFloat = 26
  let canvas: Canvas
  let hints: NSTextField
  let zoom: NSTextField

  init(canvas: Canvas, frame: NSRect) {
    self.canvas = canvas
    hints = label("V 選取 · 拖曳畫出標註，Shift 鎖定比例 · 雙擊文字可編輯 · ⌫ 刪除 · [ ] 粗細 · F 填滿 · Enter 完成")
    zoom = label("100%")
    zoom.alignment = .right
    super.init(frame: frame)
    addSubview(canvas)
    addSubview(hints)
    addSubview(zoom)
    place()
  }

  required init?(coder: NSCoder) { fatalError() }

  override func resizeSubviews(withOldSize oldSize: NSSize) {
    place()
  }

  func place() {
    let foot = Container.footHeight
    canvas.frame = NSRect(x: 0, y: foot, width: bounds.width, height: max(1, bounds.height - foot))
    let textHeight: CGFloat = 16
    let y = ((foot - textHeight) / 2).rounded()
    zoom.frame = NSRect(x: bounds.width - 72, y: y, width: 60, height: textHeight)
    hints.frame = NSRect(x: 12, y: y, width: max(0, bounds.width - 96), height: textHeight)
  }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.windowBackgroundColor.setFill()
    NSBezierPath(rect: bounds).fill()
    NSColor.separatorColor.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: Container.footHeight - 1, width: bounds.width, height: 1)).fill()
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

final class Editor: NSObject, NSWindowDelegate, NSToolbarDelegate {
  static let minSize = NSSize(width: 860, height: 420)
  static let toolsItem = NSToolbarItem.Identifier("tools")
  static let actionsItem = NSToolbarItem.Identifier("actions")
  let output: URL
  let terminal: pid_t
  let canvas: Canvas
  let container: Container
  let window: NSWindow
  var toolButtons: [IconButton] = []
  var colorButton: IconButton!
  var sizeButton: IconButton!
  var fillButton: IconButton!
  var undoButton: IconButton!
  var redoButton: IconButton!
  var toolsView: NSView!
  var actionsView: NSView!
  var popover: NSPopover?
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
      let chrome = Container.footHeight + 52
      let fit = min(1, room.width / natural.width, (room.height - chrome) / natural.height)
      return NSSize(width: natural.width * fit, height: natural.height * fit + Container.footHeight)
    }()
    size.width = min(max(size.width, Editor.minSize.width), room.width)
    size.height = min(max(size.height, Editor.minSize.height), room.height)

    container = Container(canvas: canvas, frame: NSRect(origin: .zero, size: size))
    window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init()

    buildToolbar()
    canvas.onDone = { [unowned self] in self.done() }
    canvas.onSkip = { [unowned self] in self.skip() }
    canvas.onChange = { [unowned self] in self.refresh() }
    canvas.onZoom = { [unowned self] percent in self.container.zoom.stringValue = "\(percent)%" }

    window.title = "標註 \(title)"
    window.titleVisibility = .hidden
    window.isReleasedWhenClosed = false
    window.contentView = container
    window.contentMinSize = Editor.minSize
    window.level = .floating
    window.delegate = self

    // The tools ride in the title bar, beside the window's own buttons.
    let toolbar = NSToolbar(identifier: "claude-image-preview-annotate")
    toolbar.delegate = self
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    toolbar.showsBaselineSeparator = true
    window.toolbar = toolbar
    window.toolbarStyle = .unified
    window.center()
    refresh()
  }

  func buildToolbar() {
    toolButtons = Tool.allCases.map { tool in
      IconButton(image: symbol(tool.symbol, tool.label), tip: "\(tool.label)  \(tool.key.uppercased())") {
        [unowned self] in
        self.closePopover()
        self.canvas.pick(tool)
        self.window.makeFirstResponder(self.canvas)
      }
    }
    colorButton = IconButton(image: swatch(canvas.style.color), tip: "顏色  1–8", width: 44, trailing: chevron()) {
      [unowned self] in self.showColors()
    }
    sizeButton = IconButton(
      image: thickness(canvas.style.level), tip: "粗細與文字大小  [ ]", width: 48, trailing: chevron()
    ) { [unowned self] in self.showSizes() }
    fillButton = IconButton(image: symbol("square", "外框"), tip: "外框／填滿  F") { [unowned self] in
      self.closePopover()
      self.canvas.restyle { $0.isFilled.toggle() }
      self.keepFocus()
    }
    undoButton = IconButton(image: symbol("arrow.uturn.backward", "復原"), tip: "復原  ⌘Z") { [unowned self] in
      self.canvas.undo()
      self.keepFocus()
    }
    redoButton = IconButton(image: symbol("arrow.uturn.forward", "重做"), tip: "重做  ⇧⌘Z") { [unowned self] in
      self.canvas.redo()
      self.keepFocus()
    }
    toolsView = row(
      [
        Tray(toolButtons), Tray([colorButton!, sizeButton!, fillButton!], spacing: 4),
        Tray([undoButton!, redoButton!]),
      ], spacing: 10)
    let skip = CapsuleButton(title: "略過", tip: "保留原圖", isPrimary: false) { [unowned self] in self.skip() }
    let finish = CapsuleButton(title: "完成", tip: "換成標註後的圖片  Enter", isPrimary: true) {
      [unowned self] in self.done()
    }
    actionsView = row([skip, finish], spacing: 8)
  }

  /// The toolbar as the canvas stands: its tool, its style, what can be undone.
  func refresh() {
    for (index, button) in toolButtons.enumerated() { button.isSelected = index == canvas.tool.rawValue }
    let style = canvas.style
    colorButton.image = swatch(style.color)
    sizeButton.image = thickness(style.level)
    fillButton.image = symbol(style.isFilled ? "square.fill" : "square", style.isFilled ? "填滿" : "外框")
    undoButton.isEnabled = canvas.canUndo || canvas.field != nil
    redoButton.isEnabled = canvas.canRedo
  }

  func keepFocus() {
    if canvas.field == nil { window.makeFirstResponder(canvas) }
  }

  func closePopover() {
    popover?.close()
    popover = nil
  }

  func showPopover(_ views: [NSView], below anchor: NSView) {
    closePopover()
    let content = NSStackView(views: views)
    content.orientation = .horizontal
    content.spacing = 4
    content.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
    let controller = NSViewController(nibName: nil, bundle: nil)
    controller.view = content
    content.layoutSubtreeIfNeeded()
    let pop = NSPopover()
    pop.contentViewController = controller
    pop.contentSize = content.fittingSize
    pop.behavior = .transient
    pop.animates = true
    pop.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
    popover = pop
  }

  func showColors() {
    let buttons = palette.indices.map { (index: Int) -> IconButton in
      let button = IconButton(image: swatch(palette[index], side: 20), tip: "\(colorNames[index])  \(index + 1)") {
        [unowned self] in
        self.canvas.restyle { $0.color = palette[index] }
        self.closePopover()
        self.keepFocus()
      }
      button.isSelected = palette[index] == canvas.style.color
      return button
    }
    showPopover(buttons, below: colorButton!)
  }

  func showSizes() {
    let buttons = lineSizes.indices.map { (level: Int) -> IconButton in
      let tip = "線條 \(lineSizes[level].clean) pt · 文字 \(textSizes[level].clean) pt"
      let button = IconButton(image: thickness(level, width: 26), tip: tip, width: 40) { [unowned self] in
        self.canvas.restyle { $0.level = level }
        self.closePopover()
        self.keepFocus()
      }
      button.isSelected = level == canvas.style.level
      return button
    }
    showPopover(buttons, below: sizeButton!)
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [Editor.toolsItem, .flexibleSpace, Editor.actionsItem]
  }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [Editor.toolsItem, .flexibleSpace, Editor.actionsItem]
  }

  func toolbar(
    _ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
    willBeInsertedIntoToolbar flag: Bool
  ) -> NSToolbarItem? {
    let item = NSToolbarItem(itemIdentifier: itemIdentifier)
    item.view = itemIdentifier == Editor.toolsItem ? toolsView : actionsView
    item.label = itemIdentifier == Editor.toolsItem ? "工具" : "動作"
    return item
  }

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(canvas)
  }

  func done() {
    guard !isFinished else { return }
    guard let png = canvas.png(), (try? png.write(to: output)) != nil else { fail("cannot write \(output.path)") }
    finish("saved \(terminal)")
  }

  func skip() {
    finish("skipped")
  }

  func windowDidEndLiveResize(_ notification: Notification) {
    saveSize(window.contentRect(forFrameRect: window.frame).size)
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

extension CGFloat {
  /// `4.5` as "4.5", `14` as "14".
  var clean: String { self == rounded() ? String(Int(self)) : String(format: "%.1f", Double(self)) }
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
  // No menu bar shows, but its key equivalents still serve the text field.
  let menu = NSMenu()
  let editItem = NSMenuItem()
  let edit = NSMenu(title: "Edit")
  edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
  edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
  edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
  edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
  editItem.submenu = edit
  menu.addItem(editItem)
  app.mainMenu = menu
  let editor = Editor(
    input: URL(fileURLWithPath: args[2]), output: URL(fileURLWithPath: args[3]), title: args[4])
  editor.show()
  app.run()
case "paste" where args.count >= 4:
  paste(file: URL(fileURLWithPath: args[2]), terminal: pid_t(args[3]) ?? 0)
default:
  fail("usage: annotate edit <in.png> <out.png> <title> | annotate paste <png> <pid>")
}

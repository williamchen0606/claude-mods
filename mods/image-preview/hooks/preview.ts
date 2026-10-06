// Pure helpers for the image-preview mod: no `$`, so the tests import them directly.

const IMAGE_TAG = /\[Image #(\d+)\]/g
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i

/** The ids of every `[Image #N]` placeholder in the prompt text, in order, without repeats. */
export function imageIds(text: string): number[] {
  const ids: number[] = []
  for (const match of text.matchAll(IMAGE_TAG)) {
    const id = Number(match[1])
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The image file a paste names, when the pasted text is one path to an image:
 * what a terminal types when a file is dragged onto it. Accepts the path
 * quoted, or with backslash-escaped spaces.
 */
export function droppedImagePath(inputText: string): string | null {
  let path = inputText.trim()
  const quoted = /^(['"])(.*)\1$/.exec(path)
  path = quoted ? (quoted[2] ?? '') : path.replace(/\\(.)/g, '$1')
  if (path.startsWith('file://')) path = decodeURIComponent(path.slice('file://'.length))
  if (!path.startsWith('/') || path.includes('\n')) return null
  return IMAGE_EXTENSION.test(path) ? path : null
}

/**
 * The cell box to draw a `width` x `height` picture in, keeping its aspect
 * ratio (a terminal cell is about twice as tall as it is wide) within
 * `maxColumns` x `maxRows`.
 */
export function fitCells(
  width: number,
  height: number,
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  const clamp = (n: number, hi: number) => Math.max(1, Math.min(hi, Math.round(n)))
  let rows = Math.max(1, Math.min(255, maxRows))
  let columns = clamp((rows * 2 * width) / height, Math.min(255, maxColumns))
  if (columns === Math.min(255, maxColumns)) rows = clamp((columns * height) / (2 * width), rows)
  return { columns, rows }
}

/** Parses the capture script's output, `<path> <width> <height>`. */
export function parseCapture(stdout: string): { path: string; width: number; height: number } | null {
  const match = /^(\/.+) (\d+) (\d+)$/.exec(stdout.trim())
  if (!match) return null
  const width = Number(match[2])
  const height = Number(match[3])
  return width > 0 && height > 0 ? { path: match[1] ?? '', width, height } : null
}

/** Why a capture failed, by the capture script's exit code. */
export function captureError(exitCode: number): string {
  switch (exitCode) {
    case 11:
      return '剪貼簿裡沒有圖片'
    case 12:
      return '找不到讀取剪貼簿的工具（Linux 需要 wl-paste 或 xclip）'
    case 13:
      return '讀不到拖曳進來的檔案'
    case 14:
      return '無法把圖片轉成 PNG（macOS 需要 sips，Linux 需要 ImageMagick）'
    case 15:
      return '讀到的內容不是 PNG'
    default:
      return `擷取失敗（exit ${exitCode}）`
  }
}

/**
 * Writes the image to `$TMPDIR/claude-image-preview/<name>.png` and prints
 * `<path> <width> <height>`.
 *
 * `sh -c CAPTURE_SCRIPT sh clipboard <name>` reads the clipboard
 * (macOS: pngpaste, else osascript; Linux: wl-paste, else xclip);
 * `sh -c CAPTURE_SCRIPT sh file <name> <path>` copies a dropped file,
 * converting it to PNG when it is not one. Exit codes: see captureError.
 */
export const CAPTURE_SCRIPT = `
set -u
mode=$1
dir="\${TMPDIR:-/tmp}"
dir="\${dir%/}/claude-image-preview"
mkdir -p "$dir" || exit 10
find "$dir" -name '*.png' -mmin +1440 -exec rm -f {} + 2>/dev/null
out="$dir/$2.png"
case "$mode" in
clipboard)
  case "$(uname -s)" in
  Darwin)
    if command -v pngpaste >/dev/null 2>&1; then
      pngpaste "$out" >/dev/null 2>&1 || exit 11
    else
      osascript -e 'on run argv' -e 'set png to (the clipboard as «class PNGf»)' -e 'set f to open for access (POSIX file (item 1 of argv)) with write permission' -e 'set eof f to 0' -e 'write png to f' -e 'close access f' -e 'end run' "$out" >/dev/null 2>&1 || exit 11
    fi
    ;;
  *)
    if [ -n "\${WAYLAND_DISPLAY:-}" ] && command -v wl-paste >/dev/null 2>&1; then
      wl-paste --no-newline --type image/png >"$out" 2>/dev/null || exit 11
    elif command -v xclip >/dev/null 2>&1; then
      xclip -selection clipboard -t image/png -o >"$out" 2>/dev/null || exit 11
    else
      exit 12
    fi
    ;;
  esac
  ;;
file)
  src=$3
  [ -f "$src" ] || exit 13
  case "$(printf %s "$src" | tr 'A-Z' 'a-z')" in
  *.png) cp "$src" "$out" || exit 13 ;;
  *)
    if command -v sips >/dev/null 2>&1; then
      sips -s format png "$src" --out "$out" >/dev/null 2>&1 || exit 14
    elif command -v magick >/dev/null 2>&1; then
      magick "$src" "png:$out" 2>/dev/null || exit 14
    elif command -v convert >/dev/null 2>&1; then
      convert "$src" "png:$out" 2>/dev/null || exit 14
    else
      exit 14
    fi
    ;;
  esac
  ;;
esac
[ -s "$out" ] || { rm -f "$out"; exit 11; }
[ "$(od -An -tx1 -N8 "$out" | tr -d ' \\n')" = 89504e470d0a1a0a ] || { rm -f "$out"; exit 15; }
size=$(od -An -tu1 -j16 -N8 "$out" | awk '{ printf "%d %d", $1*16777216 + $2*65536 + $3*256 + $4, $5*16777216 + $6*65536 + $7*256 + $8 }')
printf '%s %s' "$out" "$size"
`

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
  const match = /(\/.*\S) (\d+) (\d+)\s*$/.exec(stdout)
  if (!match) return null
  const width = Number(match[2])
  const height = Number(match[3])
  return width > 0 && height > 0 ? { path: match[1] ?? '', width, height } : null
}

/** Why a capture failed, by the capture script's exit code. */
export function captureError(exitCode: number): string {
  switch (exitCode) {
    case 11:
      return '找不到 Claude Code 存下的圖片'
    case 14:
      return '無法把圖片轉成 PNG（macOS 需要 sips，Linux 需要 ImageMagick）'
    case 15:
      return '圖片檔不是 PNG'
    case 17:
      return '圖片檔不完整，讀不到尺寸'
    default:
      return `讀取失敗（exit ${exitCode}）`
  }
}

/**
 * Finds the file Claude Code stored for `[Image #<id>]` and prints
 * `<path> <width> <height>`.
 *
 * `sh -c FIND_SCRIPT sh <sessionId> <id>`. Claude Code writes each pasted
 * image, as it is pasted, to `<temp>/claude-<uid>/<project>/<sessionId>/images/<id>.<ext>`;
 * the script looks under each place that temp folder can be. A PNG is used
 * where it lies; another format is converted into
 * `$TMPDIR/claude-image-preview/`. Exit codes: see captureError.
 */
export const FIND_SCRIPT = `
set -u
sid=$1
id=$2
uid=$(id -u)
tmp="\${TMPDIR:-/tmp}"
found=
for root in "\${CLAUDE_CODE_TMPDIR:-/nonexistent}/claude-$uid" "\${tmp%/}/claude-$uid" "/tmp/claude-$uid" "/private/tmp/claude-$uid"; do
  [ -d "$root" ] || continue
  found=$(find "$root" -maxdepth 4 -type f -path "*/$sid/images/$id.*" 2>/dev/null | head -n 1)
  [ -n "$found" ] && break
done
[ -n "$found" ] || exit 11
# Claude Code may still be writing the file. A PNG is whole once it ends in
# its IEND chunk; another format once its size holds still. After about 6s
# go on anyway and let the header check decide.
prev=-1
stable=0
tries=0
while [ "$tries" -lt 40 ]; do
  case "$found" in
  *.png)
    [ "$(tail -c 12 "$found" | od -An -tx1 | tr -d ' \\n')" = 0000000049454e44ae426082 ] && break
    ;;
  *)
    bytes=$(wc -c <"$found" | tr -d ' ')
    if [ "$bytes" -gt 0 ] && [ "$bytes" = "$prev" ]; then
      stable=$((stable + 1))
      [ "$stable" -ge 2 ] && break
    else
      stable=0
    fi
    prev=$bytes
    ;;
  esac
  tries=$((tries + 1))
  sleep 0.15
done
case "$found" in
*.png) out=$found ;;
*)
  dir="\${tmp%/}/claude-image-preview"
  mkdir -p "$dir" || exit 14
  find "$dir" -name '*.png' -mmin +1440 -exec rm -f {} + 2>/dev/null
  out="$dir/$sid-$id.png"
  if command -v sips >/dev/null 2>&1; then
    sips -s format png "$found" --out "$out" >/dev/null 2>&1 || exit 14
  elif command -v magick >/dev/null 2>&1; then
    magick "$found" "png:$out" 2>/dev/null || exit 14
  elif command -v convert >/dev/null 2>&1; then
    convert "$found" "png:$out" 2>/dev/null || exit 14
  else
    exit 14
  fi
  ;;
esac
[ "$(od -An -tx1 -N8 "$out" | tr -d ' \\n')" = 89504e470d0a1a0a ] || exit 15
size=$(od -An -tu1 -j16 -N8 "$out" 2>/dev/null | awk 'NF == 8 { printf "%d %d", $1*16777216 + $2*65536 + $3*256 + $4, $5*16777216 + $6*65536 + $7*256 + $8 }')
case "$size" in
'' | "0 "* | *" 0") exit 17 ;;
esac
printf '%s %s' "$out" "$size"
`

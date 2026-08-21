#!/usr/bin/env bash
#
# Normalizes screen recordings for the docs site.
#
#   ./scripts/encode-video.sh ~/Desktop/tap-flow.mov
#   ./scripts/encode-video.sh -h 720 recordings/*.mov
#   ./scripts/encode-video.sh -p 6 recordings/wizard.mov
#
# Each input produces static/video/<name>.mp4 plus a <name>.jpg poster frame.
# Reference them from MDX as <Video src="/video/<name>.mp4" portrait />.
#
# Encoding notes:
#   -an              docs clips are silent, and muted video autoplays everywhere
#   -movflags +faststart  playback starts before the whole file has downloaded
#   -pix_fmt yuv420p  required for Safari and iOS
#   -crf 28          visually lossless enough for flat UI, roughly 30x smaller
#                    than the same clip as a GIF

set -euo pipefail

HEIGHT=900
CRF=28
POSTER_AT=""  # seconds into the clip; defaults to a quarter of the duration
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/static/video"

usage() {
  echo "usage: $(basename "$0") [-h HEIGHT] [-c CRF] [-p POSTER_SECONDS] [-o OUT_DIR] input [input...]" >&2
  exit 1
}

while getopts ":h:c:p:o:" opt; do
  case "$opt" in
    h) HEIGHT="$OPTARG" ;;
    c) CRF="$OPTARG" ;;
    p) POSTER_AT="$OPTARG" ;;
    o) OUT_DIR="$OPTARG" ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))

[ "$#" -gt 0 ] || usage

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is not installed (brew install ffmpeg)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

for input in "$@"; do
  if [ ! -f "$input" ]; then
    echo "skipping $input: not a file" >&2
    continue
  fi

  name="$(basename "${input%.*}")"
  # Lowercase, spaces and underscores to hyphens, so URLs stay tidy.
  slug="$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr ' _' '--')"
  video="$OUT_DIR/$slug.mp4"
  poster="$OUT_DIR/$slug.jpg"

  # scale=-2 keeps the aspect ratio and rounds the width to an even number,
  # which H.264 requires.
  ffmpeg -y -loglevel error -i "$input" \
    -vf "scale=-2:$HEIGHT" \
    -c:v libx264 -crf "$CRF" -preset slow \
    -pix_fmt yuv420p -movflags +faststart -an \
    "$video"

  # The first frame of a demo is usually an empty terminal or a splash screen,
  # so the poster comes from a quarter of the way in unless -p says otherwise.
  poster_at="$POSTER_AT"
  if [ -z "$poster_at" ]; then
    duration="$(ffprobe -v error -show_entries format=duration \
      -of default=noprint_wrappers=1:nokey=1 "$video")"
    poster_at="$(LC_NUMERIC=C awk -v d="$duration" 'BEGIN { printf "%.2f", d / 4 }')"
  fi

  ffmpeg -y -loglevel error -ss "$poster_at" -i "$video" -frames:v 1 -q:v 4 "$poster"

  size="$(du -h "$video" | cut -f1 | tr -d ' ')"
  echo "$video ($size)"
done

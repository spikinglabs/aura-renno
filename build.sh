#!/bin/sh
# Builds the installable app (app/) from src/app.html.
set -e
case "${GOOGLE_CLIENT_ID}${GOOGLE_PICKER_KEY}" in *[!A-Za-z0-9._-]*) echo 'GOOGLE_CLIENT_ID / GOOGLE_PICKER_KEY contain unexpected characters' >&2; exit 1;; esac
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#1F1A17">\n<link rel="manifest" href="manifest.json">\n<link rel="icon" href="icon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<style>:root{padding-top:env(safe-area-inset-top,0px)}body{margin:0}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head><body>\n'
  # Aura's Google client ID and picker key come from the environment (repo variables in CI); empty means users enter their own.
  sed -e "s/__GOOGLE_CLIENT_ID__/${GOOGLE_CLIENT_ID:-__GOOGLE_CLIENT_ID__}/" -e "s/__GOOGLE_PICKER_KEY__/${GOOGLE_PICKER_KEY:-__GOOGLE_PICKER_KEY__}/" src/app.html
  printf '\n</body></html>\n'
} > app/index.html

#!/bin/sh
# Builds the installable app (app/) from src/app.html.
set -e
case "${GOOGLE_CLIENT_ID}${GOOGLE_PICKER_KEY}" in *[!A-Za-z0-9._-]*) echo 'GOOGLE_CLIENT_ID / GOOGLE_PICKER_KEY contain unexpected characters' >&2; exit 1;; esac
# Cloudflare Pages sets CF_PAGES_BRANCH. A production build without Auri's Google values would ship an app whose
# Drive sync can't start, so it stops here instead.
if [ "${CF_PAGES_BRANCH}" = main ] && { [ -z "${GOOGLE_CLIENT_ID}" ] || [ -z "${GOOGLE_PICKER_KEY}" ]; }; then
  echo 'Production build needs GOOGLE_CLIENT_ID and GOOGLE_PICKER_KEY (Cloudflare Pages → Settings → Variables).' >&2; exit 1
fi
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#1F1A17">\n<link rel="manifest" href="manifest.json">\n<link rel="icon" href="icon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Allo Auri">\n<meta name="description" content="Allo Auri is a private baby log for parents: feeds, sleep, sick days, medicines, vaccinations and the U-Heft, kept on your phone and in your own Google Drive.">\n<link rel="canonical" href="https://auri.allo.land/">\n<meta property="og:title" content="Allo Auri · A private baby log for parents">\n<meta property="og:description" content="Feeds, sleep, sick days, medicines and vaccinations, kept on your phone and in your own Google Drive.">\n<meta property="og:url" content="https://auri.allo.land/">\n<meta property="og:image" content="https://auri.allo.land/icon-512.png">\n<style>:root{padding-top:env(safe-area-inset-top,0px)}body{margin:0}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head><body>\n'
  # Aura's Google client ID and picker key come from the environment (repo variables in CI); empty means users enter their own.
  sed -e "s/__GOOGLE_CLIENT_ID__/${GOOGLE_CLIENT_ID:-__GOOGLE_CLIENT_ID__}/" -e "s/__GOOGLE_PICKER_KEY__/${GOOGLE_PICKER_KEY:-__GOOGLE_PICKER_KEY__}/" src/app.html
  printf '\n</body></html>\n'
} > app/index.html

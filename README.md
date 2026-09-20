# Leap

A Chrome new-tab page that shows your bookmarks grouped by folder, your open tabs, and
your recently closed tabs — searchable almost entirely from the keyboard.

<!-- TODO: drop a real screenshot here, e.g. docs/screenshot.png -->
<!-- ![Leap screenshot](docs/screenshot.png) -->

## Why

Opening a new tab usually gives you a blank page and a search box. Leap gives you
everything you might actually want to get back to — bookmarks, open tabs, recently
closed tabs — laid out and instantly searchable, without ever touching the mouse.

## Features

- **Bookmarks by folder** — reads your Chrome Bookmarks Bar directly; each folder
  becomes its own section, loose bookmarks land in a "Bookmarks Bar" section
- **Open tabs & recently closed tabs** — switches to an already-open tab instead of
  duplicating it, and restores closed tabs with their history intact
- **Incremental search** — type to filter instantly; space-separated words narrow
  further, and a folder name alone matches everything inside it
- **Keyboard-first** — `Ctrl+P`/`Ctrl+N` to move the selection, `Enter` to open it,
  `Ctrl+<letter>` to jump straight to a result, `Esc` to clear
- **Time-of-day mood** — the paper color and one of 500 rotating greetings shift
  through dawn / day / dusk / night / late-night (or pin it to one you like)
- **English & Japanese** — full UI and greeting translation, switchable anytime
- **No build step** — plain HTML/CSS/JS, Manifest V3, nothing to compile

## Install (not on the Web Store yet)

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Open a new tab

## Keyboard shortcuts

| Action | Key |
|---|---|
| Narrow down | Type letters |
| Narrow down further | Separate words with a space |
| Move selection | `Ctrl+P` / `Ctrl+N` |
| Open selection | `Enter` |
| Jump directly to a result | `Ctrl+<letter>` (shown once ≤9 results match) |
| Clear search | `Esc` |

All of this is also listed inside the extension itself, via the gear icon in the
top-right corner — which also has an "ask an AI" prompt you can paste into whatever
assistant you use if you'd rather learn it conversationally.

## Permissions, and why

| Permission | Used for |
|---|---|
| `bookmarks` | Reading your Bookmarks Bar to build the folder sections |
| `tabs` | Listing open tabs, switching to one, and opening `chrome://bookmarks/` |
| `sessions` | Listing and restoring recently closed tabs |
| `storage` | Remembering your view/mood/language choice between sessions |
| `favicon` | Showing each bookmark's real favicon without any external network request |

Nothing here talks to a server Leap controls — there isn't one. Everything runs
locally in the page.

## Tech notes

Vanilla JavaScript, no framework, no bundler, no build step. Manifest V3.
`i18n.js` holds the translated strings and greeting pools; `newtab.js` holds all the
logic; `redirect-focus.js` works around Chrome always focusing the omnibox on a
freshly-opened tab, so the search field can actually receive your first keystroke.

## License

MIT

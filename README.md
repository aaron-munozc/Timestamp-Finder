# YouTube Comment Timestamp Finder

A WXT + React + Tailwind CSS v4 browser extension that adds a dark, compact timestamp panel to YouTube video pages. It searches comment text for timecodes such as `2:14`, `12:48`, and `1:02:14`, groups multiple timecodes from the same comment, and lets you jump to a moment with one click.

## Features

- Injects only on YouTube domains and shows its panel only on video routes (watch pages and Shorts).
- Scans comments already loaded by YouTube, then scrolls through the comment section to prompt more comments to load.
- Expands loaded replies and "Read more" comment text where it can recognize those controls.
- Groups multiple timestamps under their original comment and sorts comments by their earliest timecode.
- Supports long videos with timestamps like `100:00`, validates seconds/minutes in timestamp formats, and de-duplicates repeated timecodes within the same comment.
- Expands long comment text on demand so the full context is available without making every card huge.
- Shows a subtle animated progress indicator while a deep scan is running, plus visible keyboard-focus styling.
- Search by comment text, creator, or timestamp.
- Minimize the panel to a floating timestamp button when it gets in the way.
- Includes a popup with quick actions to start a scan or reopen the page panel.
- Processes comments locally in the page; the extension makes no network requests and has no remote service.

## Install for development (Chrome / Chromium)

1. Install Node.js (an active LTS release is recommended).
2. In this directory, run `npm install`.
3. Run `npm run build`.
4. Open `chrome://extensions` and enable **Developer mode**.
5. Choose **Load unpacked** and select the generated `.output/chrome-mv3` directory.
6. Open or refresh a YouTube video. The Timestamp Finder panel appears near the top-right. Use **Scan all comments** to load and index more comments.

For iterative development, run `npm run dev` and follow the WXT instructions in the terminal.

## Firefox

Run `npm run build:firefox`, then load the generated Firefox output from `about:debugging` → **This Firefox** → **Load Temporary Add-on**. Select the generated `manifest.json` in the output directory.

## Notes and limitations

- YouTube lazy-loads comments. A deep scan scrolls the page and temporarily changes the scroll position while loading, then returns to the original position. Press **Stop scan** at any time.
- The scan stops when the page bottom no longer yields new comments for several passes, or at a safety limit. If YouTube stops serving comments, requires sign-in, or leaves more replies collapsed behind an unrecognized control, not every comment can be retrieved by the extension.
- The extension detects timestamps in comment text; it does not infer chapter titles or parse video descriptions.
- On Shorts, open the comments drawer before scanning.
- Timecodes are interpreted as minutes:seconds or hours:minutes:seconds. Clicking a timecode seeks and attempts to resume playback.

## Styling architecture

The in-page panel stylesheet lives in `entrypoints/styles/content.css` instead of inside the content-script template string. `content.ts` imports it with `?inline` and adds the processed CSS to the panel Shadow DOM; this keeps the styling isolated from YouTube's page CSS. Tailwind CSS v4 is configured through `@tailwindcss/vite`, and each stylesheet uses an explicit `@source` directive so classes in its corresponding TS/TSX entry point are detected. The popup stylesheet is separate at `entrypoints/styles/index.css`.

## Project structure

- `entrypoints/content.ts` — YouTube route detection, comment scanning, timestamp parsing, and the Shadow DOM panel behavior.
- `entrypoints/styles/content.css` — injected panel styling and Tailwind utilities, imported as processed CSS text and attached inside the Shadow DOM.
- `entrypoints/styles/index.css` — popup styles and Tailwind utilities.
- `entrypoints/popup/` — React popup UI.
- `wxt.config.ts` — extension metadata, host scope, icons, and the Tailwind Vite plugin.

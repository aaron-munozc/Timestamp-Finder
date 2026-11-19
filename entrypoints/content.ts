import contentStyles from "./styles/content.css?inline";

type Timestamp = {
	label: string;
	seconds: number;
};

type TimestampComment = {
	id: string;
	author: string;
	text: string;
	timestamps: Timestamp[];
};

type RuntimeMessage = { type?: string };
type DuplicateMode = "all" | "group" | "hide";
type DisplaySettings = {
	mode: DuplicateMode;
	toleranceSeconds: number;
};
type TimestampOccurrence = {
	comment: TimestampComment;
	timestamp: Timestamp;
	timestampIndex: number;
};

const SETTINGS_STORAGE_KEY = "ytTimestampFinderDisplaySettings";
const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
	mode: "all",
	toleranceSeconds: 0,
};
const ROOT_ID = "yt-comment-timestamp-finder-root";
// Accept m:ss / mm:ss, long minute counts (for long videos), and h:mm:ss.
// Keep seconds and the minute component of hour-based timestamps in the valid 00–59 range.
const TIMESTAMP_PATTERN =
	/(?<![\d:])(?:(\d{1,3}):([0-5]?\d):([0-5]\d)|(\d{1,4}):([0-5]\d))(?![\d:])/g;

export default defineContentScript({
	matches: ["*://youtube.com/*", "*://*.youtube.com/*"],
	runAt: "document_idle",
	main() {
		let host: HTMLElement | null = null;
		let shadow: ShadowRoot | null = null;
		let currentVideoKey = "";
		let isCollapsed = false;
		let isPanelDismissed = false;
		let isScanning = false;
		let activeScanId = 0;
		let scanOriginalScrollY: number | null = null;
		let scanStatus = "Ready to scan comments";
		let scanStatusKind: "neutral" | "working" | "success" | "warning" =
			"neutral";
		let collected = new Map<string, TimestampComment>();
		let displaySettings: DisplaySettings = { ...DEFAULT_DISPLAY_SETTINGS };
		let clickedExpanders = new WeakSet<Element>();
		let renderQueued = false;
		let collectQueued = false;
		let commentObserver: MutationObserver | null = null;

		const delay = (milliseconds: number) =>
			new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

		function getVideoKey(): string | null {
			const url = new URL(location.href);
			if (url.pathname === "/watch" && url.searchParams.get("v")) {
				return `watch:${url.searchParams.get("v")}`;
			}
			const shortMatch = url.pathname.match(/^\/shorts\/([^/?]+)/);
			if (shortMatch) return `shorts:${shortMatch[1]}`;
			return null;
		}

		function getVideoTitle(): string {
			const title = document
				.querySelector(
					"h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string, h1",
				)
				?.textContent?.trim();
			return (
				title ||
				document.title.replace(/\s+-\s+YouTube\s*$/i, "").trim() ||
				"Current video"
			);
		}

		function formatTime(totalSeconds: number): string {
			const seconds = Math.max(0, Math.floor(totalSeconds));
			const hours = Math.floor(seconds / 3600);
			const minutes = Math.floor((seconds % 3600) / 60);
			const remainder = seconds % 60;
			if (hours > 0)
				return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
			return `${minutes}:${String(remainder).padStart(2, "0")}`;
		}

		function parseTimestamps(text: string): Timestamp[] {
			const timestamps: Timestamp[] = [];
			TIMESTAMP_PATTERN.lastIndex = 0;
			for (const match of text.matchAll(TIMESTAMP_PATTERN)) {
				const hasHours = Boolean(match[1]);
				const hours = hasHours ? Number(match[1]) : 0;
				const minutes = Number(hasHours ? match[2] : match[4]);
				const seconds = Number(hasHours ? match[3] : match[5]);
				const total = hours * 3600 + minutes * 60 + seconds;
				if (!Number.isFinite(total)) continue;
				// Preserve every occurrence. The display preference controls whether equal or nearby
				// timecodes are shown separately, grouped together, or hidden from the current view.
				timestamps.push({ label: match[0], seconds: total });
			}
			return timestamps;
		}

		function hashText(value: string): string {
			let hash = 2166136261;
			for (let index = 0; index < value.length; index += 1) {
				hash ^= value.charCodeAt(index);
				hash = Math.imul(hash, 16777619);
			}
			return (hash >>> 0).toString(36);
		}

		function findCommentBody(comment: Element): HTMLElement | null {
			const selectors = [
				"#content-text",
				"yt-attributed-string#content-text",
				".comment-text",
				'[id="content-text"]',
			];
			for (const selector of selectors) {
				const node = comment.querySelector<HTMLElement>(selector);
				if (node) return node;
			}
			return null;
		}

		function findCommentAuthor(comment: Element): string {
			const node = comment.querySelector<HTMLElement>(
				'#author-text, #author-name, a[href*="/@"]',
			);
			return (
				node?.innerText?.trim() || node?.textContent?.trim() || "YouTube user"
			);
		}

		function findCommentIdentity(
			comment: Element,
			author: string,
			text: string,
		): string {
			const permalink =
				comment.querySelector<HTMLAnchorElement>('a[href*="lc="]');
			if (permalink?.href) {
				try {
					const commentId = new URL(
						permalink.href,
						location.href,
					).searchParams.get("lc");
					if (commentId) return commentId;
				} catch {
					// Fall through to a stable text-based identity for unusual permalink URLs.
				}
			}
			const dataId = comment.getAttribute("data-cid");
			if (dataId) return dataId;
			return hashText(`${author}\u0000${text}`);
		}

		function queueRender(): void {
			if (renderQueued) return;
			renderQueued = true;
			window.setTimeout(() => {
				renderQueued = false;
				renderResults();
			}, 90);
		}

		function scheduleCollection(): void {
			if (collectQueued) return;
			collectQueued = true;
			window.setTimeout(() => {
				collectQueued = false;
				collectComments();
				if (
					!isScanning &&
					collected.size > 0 &&
					scanStatus === "Ready to scan comments"
				) {
					setStatus(
						"Loaded comments are indexed · scan to load more",
						"neutral",
					);
				}
			}, 140);
		}

		function collectComments(): number {
			const commentNodes = Array.from(
				document.querySelectorAll<HTMLElement>(
					"#comments ytd-comment-renderer, #comments ytd-comment-view-model, ytd-comments ytd-comment-renderer, ytd-comments ytd-comment-view-model",
				),
			);
			let addedOrUpdated = 0;

			for (const comment of commentNodes) {
				const body = findCommentBody(comment);
				if (!body) continue;
				const text = (body.innerText || body.textContent || "")
					.replace(/\s+/g, " ")
					.trim();
				if (!text) continue;
				const timestamps = parseTimestamps(text);
				if (timestamps.length === 0) continue;

				const author = findCommentAuthor(comment);
				const identity = findCommentIdentity(comment, author, text);
				const entry: TimestampComment = {
					id: identity,
					author,
					text,
					timestamps,
				};
				const existing = collected.get(identity);
				if (
					!existing ||
					existing.text !== entry.text ||
					JSON.stringify(existing.timestamps) !==
						JSON.stringify(entry.timestamps)
				) {
					collected.set(identity, entry);
					addedOrUpdated += 1;
				}
			}

			if (addedOrUpdated > 0 && !isScanning) queueRender();
			return addedOrUpdated;
		}

		function getTimestampCount(): number {
			let count = 0;
			for (const comment of collected.values())
				count += comment.timestamps.length;
			return count;
		}

		function setStatus(
			message: string,
			kind: "neutral" | "working" | "success" | "warning" = "neutral",
		): void {
			scanStatus = message;
			scanStatusKind = kind;
			const status = shadow?.querySelector<HTMLElement>(
				'[data-role="status-text"]',
			);
			const indicator = shadow?.querySelector<HTMLElement>(
				'[data-role="status-indicator"]',
			);
			if (status) status.textContent = message;
			if (indicator) indicator.dataset.state = kind;
			updateCounters();
			updateScanButton();
		}

		function updateCounters(): void {
			const comments = shadow?.querySelector<HTMLElement>(
				'[data-role="comment-count"]',
			);
			const times = shadow?.querySelector<HTMLElement>(
				'[data-role="timestamp-count"]',
			);
			const bubble = shadow?.querySelector<HTMLElement>(
				'[data-role="bubble-count"]',
			);
			if (comments) comments.textContent = String(collected.size);
			if (times) times.textContent = String(getTimestampCount());
			if (bubble) bubble.textContent = String(getTimestampCount());
		}

		function updateScanButton(): void {
			const button = shadow?.querySelector<HTMLButtonElement>(
				'[data-action="scan"]',
			);
			if (!button) return;
			button.textContent = isScanning ? "Stop scan" : "Scan all comments";
			button.classList.toggle("is-stop", isScanning);
			button.setAttribute(
				"aria-label",
				isScanning ? "Stop scanning comments" : "Scan all comments",
			);
			const progress = shadow?.querySelector<HTMLElement>(
				'[data-role="scan-progress"]',
			);
			if (progress) progress.hidden = !isScanning;
		}

		function makeElement<K extends keyof HTMLElementTagNameMap>(
			tag: K,
			className?: string,
			text?: string,
		): HTMLElementTagNameMap[K] {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		function seekTo(seconds: number): void {
			const video = document.querySelector<HTMLVideoElement>(
				"#movie_player video, video.html5-main-video, ytd-player video",
			);
			const player = document.querySelector<
				HTMLElement & {
					seekTo?: (time: number, allowSeekAhead: boolean) => void;
				}
			>("#movie_player");
			let seekRequested = false;
			if (player && typeof player.seekTo === "function") {
				try {
					player.seekTo(seconds, true);
					seekRequested = true;
				} catch {
					// Fall back to the native video element if the player API is not ready.
				}
			}
			if (!seekRequested && video) {
				try {
					video.currentTime = seconds;
					seekRequested = true;
				} catch {
					// The video may not be seekable yet.
				}
			}
			if (video) {
				try {
					if (video.paused) void video.play().catch(() => undefined);
				} catch {
					// Ignore autoplay restrictions; the seek itself has already been requested.
				}
			}
		}

		function getFilteredEntries(): TimestampComment[] {
			const query =
				shadow
					?.querySelector<HTMLInputElement>('[data-role="filter"]')
					?.value.trim()
					.toLocaleLowerCase() || "";
			const entries = Array.from(collected.values());
			const filtered = query
				? entries.filter((entry) => {
						const timeText = entry.timestamps
							.map(
								(timestamp) =>
									`${timestamp.label} ${formatTime(timestamp.seconds)}`,
							)
							.join(" ");
						return `${entry.author} ${entry.text} ${timeText}`
							.toLocaleLowerCase()
							.includes(query);
					})
				: entries;
			return filtered.sort((a, b) => {
				const aTime = Math.min(
					...a.timestamps.map((timestamp) => timestamp.seconds),
				);
				const bTime = Math.min(
					...b.timestamps.map((timestamp) => timestamp.seconds),
				);
				return aTime - bTime || a.author.localeCompare(b.author);
			});
		}

		function parseDisplaySettings(value: unknown): DisplaySettings {
			const stored =
				value && typeof value === "object"
					? (value as Partial<DisplaySettings>)
					: {};
			const mode: DuplicateMode =
				stored.mode === "group" ||
				stored.mode === "hide" ||
				stored.mode === "all"
					? stored.mode
					: DEFAULT_DISPLAY_SETTINGS.mode;
			const numberValue = Number(stored.toleranceSeconds);
			const toleranceSeconds = Number.isFinite(numberValue)
				? Math.max(0, Math.min(60, Math.floor(numberValue)))
				: DEFAULT_DISPLAY_SETTINGS.toleranceSeconds;
			return { mode, toleranceSeconds };
		}

		function getModeLabel(mode = displaySettings.mode): string {
			if (mode === "group") return "Group nearby";
			if (mode === "hide") return "Hide nearby";
			return "Show all";
		}

		function updateDisplaySettingsUi(): void {
			const modeSelect = shadow?.querySelector<HTMLSelectElement>(
				'[data-role="duplicate-mode"]',
			);
			const toleranceInput = shadow?.querySelector<HTMLInputElement>(
				'[data-role="tolerance-seconds"]',
			);
			const summary = shadow?.querySelector<HTMLElement>(
				'[data-role="settings-summary"]',
			);
			const hint = shadow?.querySelector<HTMLElement>(
				'[data-role="settings-hint"]',
			);
			if (modeSelect) modeSelect.value = displaySettings.mode;
			if (toleranceInput)
				toleranceInput.value = String(displaySettings.toleranceSeconds);
			if (summary)
				summary.textContent = `${getModeLabel()} · ${displaySettings.toleranceSeconds}s`;
			if (hint) {
				if (displaySettings.mode === "group") {
					hint.textContent = `Timestamps within ${displaySettings.toleranceSeconds}s of a group's earliest time are shown together.`;
				} else if (displaySettings.mode === "hide") {
					hint.textContent = `Only the earliest timestamp button in each ${displaySettings.toleranceSeconds}s group stays visible. Comments remain visible; choose another mode to restore every button.`;
				} else {
					hint.textContent =
						"All timestamp mentions stay visible. The tolerance is used only by grouping or hiding modes (0–60 seconds).";
				}
			}
		}

		async function loadDisplaySettings(): Promise<void> {
			try {
				const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
				if (stored[SETTINGS_STORAGE_KEY] !== undefined) {
					displaySettings = parseDisplaySettings(stored[SETTINGS_STORAGE_KEY]);
				}
			} catch (error) {
				console.warn(
					"[Comment Timestamp Finder] Could not load display settings:",
					error,
				);
			}
			updateDisplaySettingsUi();
			renderResults();
		}

		async function saveDisplaySettings(): Promise<void> {
			try {
				await browser.storage.local.set({
					[SETTINGS_STORAGE_KEY]: displaySettings,
				});
			} catch (error) {
				console.warn(
					"[Comment Timestamp Finder] Could not save display settings:",
					error,
				);
			}
		}

		function getTimestampOccurrences(
			entries: TimestampComment[],
		): TimestampOccurrence[] {
			const occurrences: TimestampOccurrence[] = [];
			for (const comment of entries) {
				comment.timestamps.forEach((timestamp, timestampIndex) => {
					occurrences.push({ comment, timestamp, timestampIndex });
				});
			}
			return occurrences.sort(
				(a, b) =>
					a.timestamp.seconds - b.timestamp.seconds ||
					a.comment.author.localeCompare(b.comment.author) ||
					a.comment.id.localeCompare(b.comment.id) ||
					a.timestampIndex - b.timestampIndex,
			);
		}

		function groupTimestampOccurrences(
			occurrences: TimestampOccurrence[],
		): TimestampOccurrence[][] {
			const groups: TimestampOccurrence[][] = [];
			for (const occurrence of occurrences) {
				const currentGroup = groups[groups.length - 1];
				const firstOccurrence = currentGroup?.[0];

				if (
					firstOccurrence &&
					occurrence.timestamp.seconds - firstOccurrence.timestamp.seconds <=
					displaySettings.toleranceSeconds
				) {
					currentGroup.push(occurrence);
				} else {
					groups.push([occurrence]);
				}
			}
			return groups;
		}

		function hideNearbyTimestampOccurrences(
			entries: TimestampComment[],
		): TimestampComment[] {
			const groups = groupTimestampOccurrences(
				getTimestampOccurrences(entries),
			);
			const keepIndices = new Map<string, Set<number>>();

			for (const group of groups) {
				const first = group[0];
				if (!first) continue;

				const indices = keepIndices.get(first.comment.id) || new Set<number>();
				indices.add(first.timestampIndex);
				keepIndices.set(first.comment.id, indices);
			}

			// Keep the original comment visible even when all its timestamp buttons are redundant.
			return entries.map((entry) => ({
				...entry,
				timestamps: entry.timestamps.filter(
					(_, index) => keepIndices.get(entry.id)?.has(index) ?? false,
				),
			}));
		}

		function appendCommentText(parent: HTMLElement, text: string): void {
			const commentText = makeElement("p", "comment-text", text);
			parent.append(commentText);
			if (text.length <= 190) return;
			const expandComment = makeElement(
				"button",
				"comment-expand",
				"Show full comment",
			) as HTMLButtonElement;
			expandComment.type = "button";
			expandComment.setAttribute("aria-expanded", "false");
			expandComment.addEventListener("click", () => {
				const expanded = commentText.classList.toggle("is-expanded");
				expandComment.textContent = expanded
					? "Show less"
					: "Show full comment";
				expandComment.setAttribute("aria-expanded", String(expanded));
			});
			parent.append(expandComment);
		}

		function renderCommentResults(
			list: HTMLElement,
			entries: TimestampComment[],
		): void {
			for (const entry of entries) {
				const card = makeElement("article", "comment-card");
				const top = makeElement("div", "comment-topline");
				const avatar = makeElement(
					"span",
					"avatar",
					(entry.author.trim()[0] || "Y").toLocaleUpperCase(),
				);
				avatar.setAttribute("aria-hidden", "true");
				const authorWrap = makeElement("div", "author-wrap");
				authorWrap.append(makeElement("div", "comment-author", entry.author));
				authorWrap.append(
					makeElement(
						"div",
						"comment-caption",
						entry.timestamps.length === 0
							? "Nearby duplicate hidden"
							: `${entry.timestamps.length} ${entry.timestamps.length === 1 ? "timestamp mention" : "timestamp mentions"}`,
					),
				);
				top.append(avatar, authorWrap);

				const timeRow = makeElement("div", "time-row");
				for (const timestamp of entry.timestamps) {
					const button = makeElement(
						"button",
						"time-chip",
					) as HTMLButtonElement;
					button.type = "button";
					button.title = `Jump to ${formatTime(timestamp.seconds)}`;
					button.append(makeElement("span", "chip-play", "▶"));
					button.append(document.createTextNode(formatTime(timestamp.seconds)));
					button.addEventListener("click", () => seekTo(timestamp.seconds));
					timeRow.append(button);
				}
				card.append(top);
				appendCommentText(card, entry.text);
				if (entry.timestamps.length > 0) card.append(timeRow);
				else
					card.append(
						makeElement(
							"div",
							"duplicate-note",
							"Timestamp hidden because a nearby moment is already shown.",
						),
					);
				list.append(card);
			}
		}

		function renderGroupedResults(
			list: HTMLElement,
			groups: TimestampOccurrence[][],
		): void {
			for (const group of groups) {
				if (group.length === 0) continue;

				const first = group[0];
				const last = group[group.length - 1];
				if (!first || !last) continue;

				const card = makeElement("article", "moment-group-card");
				const header = makeElement("div", "moment-group-header");
				const firstSeconds = first.timestamp.seconds;
				const lastSeconds = last.timestamp.seconds;
				const timeLabel =
					firstSeconds === lastSeconds
						? formatTime(firstSeconds)
						: `${formatTime(firstSeconds)}–${formatTime(lastSeconds)}`;
				const commentCount = new Set(group.map((item) => item.comment.id)).size;
				const mentionsLabel = `${group.length} ${group.length === 1 ? "mention" : "mentions"}`;
				const commentsLabel = `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`;
				header.append(
					makeElement("span", "moment-group-range", timeLabel),
					makeElement(
						"span",
						"moment-group-meta",
						`${commentsLabel} · ${mentionsLabel}`,
					),
				);
				card.append(header);

				// Render one jump button for each distinct time in a group, not one button per mention.
				// All matching comments remain listed underneath, so grouping never loses their context.
				const uniqueSeconds = Array.from(
					new Set(group.map((item) => item.timestamp.seconds)),
				).sort((a, b) => a - b);
				const timeRow = makeElement("div", "time-row group-time-chips");
				for (const seconds of uniqueSeconds) {
					const button = makeElement(
						"button",
						"time-chip group-time-chip",
					) as HTMLButtonElement;
					button.type = "button";
					button.title = `Jump to ${formatTime(seconds)}`;
					button.append(makeElement("span", "chip-play", "▶"));
					button.append(document.createTextNode(formatTime(seconds)));
					button.addEventListener("click", () => seekTo(seconds));
					timeRow.append(button);
				}
				card.append(timeRow);

				const byComment = new Map<string, TimestampComment>();
				for (const occurrence of group)
					byComment.set(occurrence.comment.id, occurrence.comment);
				for (const comment of byComment.values()) {
					const row = makeElement("div", "group-match");
					const top = makeElement("div", "comment-topline");
					const avatar = makeElement(
						"span",
						"avatar",
						(comment.author.trim()[0] || "Y").toLocaleUpperCase(),
					);
					avatar.setAttribute("aria-hidden", "true");
					const authorWrap = makeElement("div", "author-wrap");
					authorWrap.append(
						makeElement("div", "comment-author", comment.author),
					);
					top.append(avatar, authorWrap);
					row.append(top);
					appendCommentText(row, comment.text);
					card.append(row);
				}
				list.append(card);
			}
		}

		function renderResults(): void {
			if (!shadow) return;
			const list = shadow.querySelector<HTMLElement>('[data-role="results"]');
			const empty = shadow.querySelector<HTMLElement>('[data-role="empty"]');
			const resultHeading = shadow.querySelector<HTMLElement>(
				'[data-role="result-heading"]',
			);
			const sortLabel = shadow.querySelector<HTMLElement>(
				'[data-role="sort-label"]',
			);
			if (!list || !empty) return;

			updateCounters();
			list.replaceChildren();
			const filteredEntries = getFilteredEntries();
			const occurrences = getTimestampOccurrences(filteredEntries);
			const groups =
				displaySettings.mode === "group"
					? groupTimestampOccurrences(occurrences)
					: [];
			const entries =
				displaySettings.mode === "hide"
					? hideNearbyTimestampOccurrences(filteredEntries)
					: filteredEntries;
			const resultCount =
				displaySettings.mode === "group" ? groups.length : entries.length;

			if (resultHeading) {
				if (displaySettings.mode === "group")
					resultHeading.textContent =
						groups.length === 1
							? "MATCHING TIME GROUP"
							: "MATCHING TIME GROUPS";
				else
					resultHeading.textContent =
						entries.length === 1 ? "MATCHING COMMENT" : "MATCHING COMMENTS";
			}
			if (sortLabel) {
				sortLabel.textContent =
					displaySettings.mode === "group"
						? `GROUPED · ${displaySettings.toleranceSeconds}s TOLERANCE`
						: displaySettings.mode === "hide"
							? "NEARBY DUPLICATES HIDDEN"
							: "EARLIEST FIRST ↗";
			}

			if (resultCount === 0) {
				list.hidden = true;
				empty.hidden = false;
				const query =
					shadow
						.querySelector<HTMLInputElement>('[data-role="filter"]')
						?.value.trim() || "";
				const title = empty.querySelector<HTMLElement>(
					'[data-role="empty-title"]',
				);
				const body = empty.querySelector<HTMLElement>(
					'[data-role="empty-copy"]',
				);
				if (title)
					title.textContent = query
						? "No matching timestamps"
						: "No timestamps found yet";
				if (body) {
					body.textContent = query
						? "Try another word, creator name, or timecode."
						: isScanning
							? "Looking through comments as YouTube loads them…"
							: "Scan the comments to find timecodes such as 2:14 or 1:02:14.";
				}
				return;
			}

			list.hidden = false;
			empty.hidden = true;
			if (displaySettings.mode === "group") renderGroupedResults(list, groups);
			else renderCommentResults(list, entries);
		}

		function renderShell(): void {
			if (!host || !shadow) return;
			shadow.innerHTML = `

        <section class="panel" data-role="panel" aria-label="YouTube comment timestamps">
          <header class="topbar">
            <div class="brand">
              <div class="brand-mark" aria-hidden="true">
                <svg viewBox="0 0 48 48" focusable="false">
                  <path d="M17 21h14l11 20H6z" fill="#0089ef" stroke="#17191e" stroke-width="2.5" stroke-linejoin="round" />
                  <circle cx="24" cy="15" r="10" fill="#ffdc00" stroke="#17191e" stroke-width="2.5" />
                  <path d="M24 9v6h6" fill="none" stroke="#17191e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
                  <rect x="6" y="35" width="36" height="8" rx="3" fill="#00b3d4" stroke="#17191e" stroke-width="2.5" />
                </svg>
              </div>
              <div style="min-width:0">
                <div class="eyebrow">COMMENT TIMESTAMP FINDER</div>
                <span class="video-title" data-role="video-title">Current video</span>
              </div>
            </div>
            <div class="panel-controls" role="group" aria-label="Panel controls">
              <button class="collapse" type="button" data-action="collapse" aria-label="Minimize panel" title="Minimize to floating button">−</button>
              <button class="close-panel" type="button" data-action="close" aria-label="Close timestamp panel" title="Close panel">×</button>
            </div>
          </header>
          <section class="intro">
            <div class="intro-label">YOUR COMMENT INDEX</div>
            <p class="intro-copy">Find timecodes people left in the comments, then jump straight to that moment.</p>
            <div class="metrics">
              <div class="metric"><span class="metric-number" data-role="timestamp-count">0</span><span class="metric-label">Timestamps found</span></div>
              <div class="metric"><span class="metric-number" data-role="comment-count">0</span><span class="metric-label">Comments matched</span></div>
            </div>
          </section>
          <div class="actions">
            <button class="scan-button" type="button" data-action="scan">Scan all comments</button>
            <button class="rescan-button" type="button" data-action="rescan" title="Clear results and start again" aria-label="Rescan from scratch">↻</button>
          </div>
          <div class="status-line"><span class="status-dot" data-role="status-indicator" data-state="neutral"></span><span data-role="status-text">Ready to scan comments</span></div>
          <div class="scan-progress" data-role="scan-progress" aria-hidden="true" hidden><span></span></div>
          <div class="search-wrap">
            <label class="search-box"><span class="search-icon" aria-hidden="true">⌕</span><input data-role="filter" type="search" placeholder="Search comments, authors, or time…" autocomplete="off" /></label>
          </div>
          <details class="duplicate-settings" data-role="duplicate-settings">
            <summary class="settings-toggle"><span>Timestamp display</span><span class="settings-current" data-role="settings-summary">Show all · 0s</span></summary>
            <div class="settings-body">
              <label class="setting-field"><span>Repeated / nearby timestamps</span>
                <select data-role="duplicate-mode">
                  <option value="all">Show all separately</option>
                  <option value="group">Group nearby timestamps</option>
                  <option value="hide">Hide nearby duplicates</option>
                </select>
              </label>
              <label class="setting-field tolerance-field"><span>Acceptable time difference</span>
                <span class="seconds-input"><input data-role="tolerance-seconds" type="number" min="0" max="60" step="1" value="0" inputmode="numeric" /><span>seconds</span></span>
              </label>
              <p class="settings-hint" data-role="settings-hint">All timestamp mentions stay visible. The tolerance is used only by grouping or hiding modes (0–60 seconds).</p>
            </div>
          </details>
          <div class="section-head"><span data-role="result-heading">MATCHING COMMENTS</span><span class="sort-label" data-role="sort-label">EARLIEST FIRST ↗</span></div>
          <div class="results" data-role="results" aria-live="polite"></div>
          <div class="empty" data-role="empty">
            <div class="empty-icon" aria-hidden="true">◷</div>
            <div class="empty-title" data-role="empty-title">No timestamps found yet</div>
            <div class="empty-copy" data-role="empty-copy">Scan the comments to find timecodes such as 2:14 or 1:02:14.</div>
          </div>
        </section>
        <button class="bubble" type="button" data-action="expand" aria-label="Open timestamp panel" title="Open timestamp panel" hidden>
          <span class="bubble-symbol" aria-hidden="true">◷</span><span class="bubble-count" data-role="bubble-count">0</span>
        </button>
      `;

			const injectedStyle = document.createElement("style");
			injectedStyle.textContent = contentStyles;
			shadow.prepend(injectedStyle);

			const collapseButton = shadow.querySelector<HTMLButtonElement>(
				'[data-action="collapse"]',
			);
			const closeButton = shadow.querySelector<HTMLButtonElement>(
				'[data-action="close"]',
			);
			const expandButton = shadow.querySelector<HTMLButtonElement>(
				'[data-action="expand"]',
			);
			const scanButton = shadow.querySelector<HTMLButtonElement>(
				'[data-action="scan"]',
			);
			const rescanButton = shadow.querySelector<HTMLButtonElement>(
				'[data-action="rescan"]',
			);
			const filter = shadow.querySelector<HTMLInputElement>(
				'[data-role="filter"]',
			);
			collapseButton?.addEventListener("click", () => setCollapsed(true));
			closeButton?.addEventListener("click", () => setPanelDismissed(true));
			expandButton?.addEventListener("click", () => setCollapsed(false));
			scanButton?.addEventListener("click", () => {
				if (isScanning) stopScan();
				else void startDeepScan();
			});
			rescanButton?.addEventListener("click", () => {
				if (isScanning) stopScan();
				collected.clear();
				clickedExpanders = new WeakSet<Element>();
				collectComments();
				setStatus("Results cleared · ready to scan again", "neutral");
				renderResults();
			});
			filter?.addEventListener("input", () => renderResults());

			const duplicateMode = shadow.querySelector<HTMLSelectElement>(
				'[data-role="duplicate-mode"]',
			);
			const toleranceInput = shadow.querySelector<HTMLInputElement>(
				'[data-role="tolerance-seconds"]',
			);
			duplicateMode?.addEventListener("change", () => {
				displaySettings = parseDisplaySettings({
					...displaySettings,
					mode: duplicateMode.value,
				});
				updateDisplaySettingsUi();
				void saveDisplaySettings();
				renderResults();
			});
			toleranceInput?.addEventListener("change", () => {
				displaySettings = parseDisplaySettings({
					...displaySettings,
					toleranceSeconds: toleranceInput.value,
				});
				updateDisplaySettingsUi();
				void saveDisplaySettings();
				renderResults();
			});

			const title = shadow.querySelector<HTMLElement>(
				'[data-role="video-title"]',
			);
			if (title) title.textContent = getVideoTitle();
			updateDisplaySettingsUi();
			renderResults();
			updateScanButton();
		}

		function setCollapsed(collapsed: boolean): void {
			isCollapsed = collapsed;
			const panel = shadow?.querySelector<HTMLElement>('[data-role="panel"]');
			const bubble = shadow?.querySelector<HTMLButtonElement>(
				'[data-action="expand"]',
			);
			if (panel) panel.hidden = isPanelDismissed || collapsed;
			if (bubble) bubble.hidden = isPanelDismissed || !collapsed;
		}

		function setPanelDismissed(dismissed: boolean): void {
			isPanelDismissed = dismissed;
			if (!dismissed) isCollapsed = false;
			setCollapsed(isCollapsed);
		}

		function mountPanel(): void {
			if (!document.documentElement) return;
			if (host && host.isConnected) return;
			host = document.createElement("div");
			host.id = ROOT_ID;
			host.setAttribute("aria-label", "Comment Timestamp Finder extension");
			shadow = host.attachShadow({ mode: "open" });
			document.documentElement.append(host);
			renderShell();
			setCollapsed(isCollapsed);
		}

		function unmountPanel(): void {
			activeScanId += 1;
			isScanning = false;
			scanOriginalScrollY = null;
			if (commentObserver) {
				commentObserver.disconnect();
				commentObserver = null;
			}
			host?.remove();
			host = null;
			shadow = null;
		}

		function observeComments(): void {
			if (commentObserver) commentObserver.disconnect();
			const comments = document.querySelector("#comments, ytd-comments");
			if (!comments) return;
			commentObserver = new MutationObserver(() => {
				scheduleCollection();
			});
			commentObserver.observe(comments, {
				childList: true,
				subtree: true,
				characterData: true,
			});
		}

		function setPageVideo(videoKey: string): void {
			activeScanId += 1;
			isScanning = false;
			scanOriginalScrollY = null;
			currentVideoKey = videoKey;
			collected = new Map<string, TimestampComment>();
			clickedExpanders = new WeakSet<Element>();
			isCollapsed = false;
			isPanelDismissed = false;
			scanStatus = "Ready to scan comments";
			scanStatusKind = "neutral";
			mountPanel();
			if (shadow) {
				const title = shadow.querySelector<HTMLElement>(
					'[data-role="video-title"]',
				);
				if (title) title.textContent = getVideoTitle();
				const filter = shadow.querySelector<HTMLInputElement>(
					'[data-role="filter"]',
				);
				if (filter) filter.value = "";
			}
			setCollapsed(false);
			setStatus("Ready to scan comments", "neutral");
			observeComments();
			collectComments();
			renderResults();
			if (location.pathname.startsWith("/shorts/")) {
				setStatus("Open the Shorts comments panel, then scan", "warning");
			}
		}

		function syncPage(): void {
			const videoKey = getVideoKey();
			if (!videoKey) {
				currentVideoKey = "";
				unmountPanel();
				return;
			}
			if (videoKey !== currentVideoKey || !host?.isConnected) {
				window.setTimeout(() => {
					if (
						getVideoKey() !== videoKey ||
						(currentVideoKey === videoKey && host?.isConnected)
					)
						return;
					setPageVideo(videoKey);
				}, 250);
			} else {
				const title = shadow?.querySelector<HTMLElement>(
					'[data-role="video-title"]',
				);
				if (title) title.textContent = getVideoTitle();
				observeComments();
				collectComments();
			}
		}

		function isVisible(element: Element): boolean {
			const htmlElement = element as HTMLElement;
			return (
				Boolean(htmlElement.getClientRects().length) &&
				getComputedStyle(htmlElement).visibility !== "hidden"
			);
		}

		function expandLoadedComments(): number {
			const comments = document.querySelector("#comments, ytd-comments");
			if (!comments) return 0;
			const candidates = Array.from(
				comments.querySelectorAll<HTMLElement>(
					'button, yt-button-shape, ytd-button-renderer, [id="more"], [id="more-replies"], [id="more-replies-button"]',
				),
			);
			let clicked = 0;
			for (const candidate of candidates) {
				const button = candidate.matches("button")
					? candidate
					: candidate.querySelector<HTMLElement>("button") || candidate;
				if (
					clickedExpanders.has(candidate) ||
					clickedExpanders.has(button) ||
					!isVisible(candidate)
				)
					continue;
				const label = [
					candidate.getAttribute("aria-label"),
					candidate.getAttribute("title"),
					candidate.innerText,
					candidate.textContent,
					button.getAttribute("aria-label"),
				]
					.filter(Boolean)
					.join(" ")
					.replace(/\s+/g, " ")
					.trim();
				const isReadMore =
					candidate.id === "more" && /read more|more/i.test(label);
				const isReplyExpander =
					/(?:view|show|see)\s+(?:(?:\d+|more|all)\s+)?repl(?:y|ies)|\d+\s+repl(?:y|ies)/i.test(
						label,
					);
				if (!isReadMore && !isReplyExpander) continue;
				if (/hide|less|collapse/i.test(label)) continue;
				clickedExpanders.add(candidate);
				clickedExpanders.add(button);
				if (button instanceof HTMLElement) {
					button.click();
					clicked += 1;
				}
			}
			return clicked;
		}

		async function startDeepScan(): Promise<void> {
			if (isScanning) return;
			isScanning = true;
			const runId = ++activeScanId;
			const originalScrollY = window.scrollY;
			scanOriginalScrollY = originalScrollY;
			let stagnantAtBottom = 0;
			let lastCount = collected.size;
			let steps = 0;
			setStatus("Scanning comments and opening available replies…", "working");
			updateScanButton();
			try {
				const comments = document.querySelector("#comments, ytd-comments");
				if (!comments) {
					isScanning = false;
					setStatus(
						"Comments are not loaded yet · open the comments section and try again",
						"warning",
					);
					return;
				}
				comments.scrollIntoView({ block: "start", behavior: "instant" });
				await delay(360);

				// YouTube appends comments as the page is scrolled. The loop keeps going
				// until the document bottom has stopped yielding new comments.
				while (runId === activeScanId && steps < 600) {
					steps += 1;
					expandLoadedComments();
					collectComments();
					const beforeHeight = document.documentElement.scrollHeight;
					const stepSize = Math.max(440, Math.floor(window.innerHeight * 0.72));
					const maxScroll = Math.max(
						0,
						document.documentElement.scrollHeight - window.innerHeight,
					);
					window.scrollTo({
						top: Math.min(maxScroll, window.scrollY + stepSize),
						behavior: "instant",
					});
					await delay(230);
					expandLoadedComments();
					collectComments();

					const count = collected.size;
					const atBottom =
						window.scrollY + window.innerHeight >=
						document.documentElement.scrollHeight - 24;
					const heightChanged =
						document.documentElement.scrollHeight > beforeHeight;
					if (count > lastCount || heightChanged || !atBottom)
						stagnantAtBottom = 0;
					else stagnantAtBottom += 1;
					lastCount = count;

					if (steps % 4 === 0) {
						setStatus(
							`Scanning comments · ${count} matched · ${getTimestampCount()} timestamps found`,
							"working",
						);
					}
					if (atBottom && stagnantAtBottom >= 5) break;
				}

				if (runId === activeScanId) {
					collectComments();
					if (steps >= 600) {
						setStatus(
							`Stopped at scan safety limit · ${collected.size} comments · ${getTimestampCount()} timestamps`,
							"warning",
						);
					} else if (collected.size === 0) {
						setStatus(
							"No timestamp comments found in loaded comments",
							"warning",
						);
					} else {
						setStatus(
							`Scan complete · ${collected.size} comments · ${getTimestampCount()} timestamps`,
							"success",
						);
					}
				}
			} catch (error) {
				console.warn("[Comment Timestamp Finder] Scan error:", error);
				if (runId === activeScanId)
					setStatus("Could not complete the scan · try again", "warning");
			} finally {
				if (runId === activeScanId) {
					isScanning = false;
					window.scrollTo({ top: originalScrollY, behavior: "instant" });
					scanOriginalScrollY = null;
					updateScanButton();
					renderResults();
				}
			}
		}

		function stopScan(): void {
			if (!isScanning) return;
			activeScanId += 1;
			isScanning = false;
			if (scanOriginalScrollY !== null) {
				window.scrollTo({ top: scanOriginalScrollY, behavior: "instant" });
				scanOriginalScrollY = null;
			}
			setStatus(
				`Scan stopped · ${collected.size} comments · ${getTimestampCount()} timestamps`,
				"warning",
			);
			updateScanButton();
			renderResults();
		}

		browser.runtime.onMessage.addListener((message: RuntimeMessage) => {
			if (message?.type === "YTTS_OPEN_PANEL") {
				syncPage();
				if (getVideoKey()) {
					window.setTimeout(() => setPanelDismissed(false), 300);
				}
			}
			if (message?.type === "YTTS_HIDE_PANEL") {
				syncPage();
				if (getVideoKey()) {
					window.setTimeout(() => setPanelDismissed(true), 350);
				}
			}
			if (message?.type === "YTTS_START_SCAN") {
				syncPage();
				window.setTimeout(() => {
					setPanelDismissed(false);
					void startDeepScan();
				}, 350);
			}
			return undefined;
		});

		document.addEventListener("yt-navigate-finish", () =>
			window.setTimeout(syncPage, 100),
		);
		document.addEventListener("yt-page-data-updated", () =>
			window.setTimeout(syncPage, 100),
		);
		window.addEventListener("popstate", () => window.setTimeout(syncPage, 100));
		window.addEventListener("hashchange", () =>
			window.setTimeout(syncPage, 100),
		);
		void loadDisplaySettings();
		syncPage();
	},
});

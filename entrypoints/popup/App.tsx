import { useEffect, useState } from "react";

type PageState = "checking" | "video" | "youtube" | "other";
type PopupAction = "YTTS_OPEN_PANEL" | "YTTS_START_SCAN" | "YTTS_HIDE_PANEL";

export default function App() {
	const [pageState, setPageState] = useState<PageState>("checking");
	const [feedback, setFeedback] = useState("");

	useEffect(() => {
		let isActive = true;

		void browser.tabs
			.query({ active: true, currentWindow: true })
			.then(([tab]) => {
				let nextState: PageState = "other";

				if (tab?.url) {
					try {
						const url = new URL(tab.url);
						if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
							nextState =
								(url.pathname === "/watch" &&
									Boolean(url.searchParams.get("v"))) ||
								/^\/shorts\//.test(url.pathname)
									? "video"
									: "youtube";
						}
					} catch {
						nextState = "other";
					}
				}

				if (isActive) setPageState(nextState);
			})
			.catch(() => {
				if (isActive) setPageState("other");
			});

		return () => {
			isActive = false;
		};
	}, []);

	async function sendAction(action: PopupAction) {
		setFeedback("");

		try {
			const [tab] = await browser.tabs.query({
				active: true,
				currentWindow: true,
			});

			if (!tab?.id) {
				setFeedback("Open or refresh a YouTube video tab, then try again.");
				return;
			}

			await browser.tabs.sendMessage(tab.id, { type: action });
			setFeedback(
				action === "YTTS_OPEN_PANEL"
					? "Timestamp panel is visible on the video."
					: action === "YTTS_HIDE_PANEL"
						? "Timestamp panel hidden. Use Show panel to bring it back."
						: "Scan started. Results will appear in the page panel.",
			);
		} catch {
			setFeedback("Open or refresh a YouTube video tab, then try again.");
		}
	}

	return (
		<main className="popup-shell">
			<header className="popup-header">
				<div className="popup-mark" aria-hidden="true">
					<img src="/logo.svg" alt="" className="brand-logo" />
				</div>
				<div className="popup-brand-copy">
					<div className="popup-eyebrow">YOUTUBE TOOL</div>
					<h1>Timestamp Finder</h1>
				</div>
				<span
					className={`connection-dot ${pageState === "video" ? "is-ready" : ""}`}
					title={
						pageState === "video"
							? "Video page detected"
							: "Waiting for a video"
					}
				/>
			</header>

			<section className="popup-status" aria-live="polite">
				<span className={`status-icon ${pageState === "video" ? "ready" : ""}`}>
					{pageState === "video" ? "✓" : "·"}
				</span>
				<div>
					<strong>
						{pageState === "video"
							? "YouTube video detected"
							: pageState === "youtube"
								? "YouTube is open"
								: pageState === "other"
									? "Waiting for YouTube"
									: "Checking current tab"}
					</strong>
					<p>
						{pageState === "video"
							? "The in-page panel is ready to use."
							: pageState === "youtube"
								? "Open a video to enable comment scanning."
								: pageState === "other"
									? "Open a YouTube video to get started."
									: "Looking for a supported page…"}
					</p>
				</div>
			</section>

			<div className="popup-actions">
				<button
					className="primary-action"
					type="button"
					onClick={() => void sendAction("YTTS_START_SCAN")}
					disabled={pageState !== "video"}
				>
					<span aria-hidden="true">⌕</span> Scan all comments
				</button>
				<button
					className="secondary-action"
					type="button"
					onClick={() => void sendAction("YTTS_OPEN_PANEL")}
					disabled={pageState !== "video"}
				>
					Show timestamp panel <span aria-hidden="true">↗</span>
				</button>
				<button
					className="secondary-action"
					type="button"
					onClick={() => void sendAction("YTTS_HIDE_PANEL")}
					disabled={pageState !== "video"}
					style={{ opacity: 0.78 }}
				>
					Hide timestamp panel <span aria-hidden="true">×</span>
				</button>
			</div>
			{feedback && (
				<div className="popup-feedback" role="status">
					{feedback}
				</div>
			)}
		</main>
	);
}

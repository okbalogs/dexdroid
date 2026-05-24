# Dexdroid

Dexdroid is a small, cross-platform peer-to-peer file transfer app built with
Tauri (Rust) and React (Vite). It aims to make fast, offline transfers simple
between devices on the same network or via a temporary Wi‑Fi hotspot. A live
screen-casting mode is included to preview a sender's screen on the receiver.

This README explains how the app works, how to run it for development, and
how to use the new screen-casting feature.

## Features

- Peer-to-peer file transfer over TCP
- BLE advertising (Linux) for quick discovery
- Create a Wi‑Fi hotspot (Linux) to receive files from devices with no network
- Live screen casting (captures sender screen and streams frames to receiver)
- Small, self-contained Rust backend with a React front-end UI

## Quick Start (Development)

Prerequisites

- Node 18+ and a package manager (`pnpm` recommended, `npm` or `yarn` also work)
- Rust toolchain (for the Tauri backend)
- On Linux: `nmcli` (NetworkManager) if you want hotspot support

Install frontend deps and run in dev mode

```bash
pnpm install
pnpm dev
```

Run Tauri (desktop) with hot reload

```bash
pnpm tauri dev
```

Build a production bundle

```bash
pnpm build
pnpm tauri build
```

Check the Rust backend

```bash
cd src-tauri
cargo check
```

Android / mobile

The project includes Android Gradle project files under `src-tauri/gen/android`.
Building an Android APK requires an Android SDK and typical Gradle tooling:

```bash
cd src-tauri/gen/android
./gradlew assembleDebug
```

See the `src-tauri/gen/android` folder for platform-specific packaging details.

## How the app works (high level)

- The frontend is in `src/` (React + Vite).
- The backend is a Tauri Rust library in `src-tauri/src/lib.rs` that:
	- manages a TCP listener for incoming transfers,
	- exposes Tauri commands (`start_server`, `stop_server`, `send_file`, etc.),
	- emits events (`transfer-progress`, `file-received`, and `screen-cast-frame`) to the UI.
- File transfers use a simple custom TCP protocol:
	- Sender connects to `peer_ip:peer_port` and sends:
		- u32 filename length (little-endian)
		- filename bytes
		- u64 file size (little-endian)
		- file bytes

## Sending a File (end-to-end)

1. On the receiver device, open Dexdroid and choose **Receive → Start Receiving**.
	 - The app starts a TCP server and shows the local IP and random port.
	 - Optionally enable a hotspot (Linux) — Dexdroid will start the server on the
		 hotspot IP and display SSID/password.
2. On the sender device, choose **Send**, enter the receiver IP and port (or scan
	 the QR code / use BLE discovery), pick a file, and press **Send**.
3. The sender streams the file; both sides show progress events. The receiver
	 saves the file to the user's downloads or home directory.

## Screen casting (how to use)

This project adds a live screen-casting flow on top of the same TCP channel.

Sender side (desktop/webview):

1. Open **Send** and enter the peer IP and port of the receiver.
2. Click **Start Screen Cast**. The app calls `navigator.mediaDevices.getDisplayMedia()`
	 to request permission to capture the screen (browser/OS screen-sharing prompt).
3. The frontend captures periodic frames from the captured MediaStream,
	 encodes frames as JPEG base64 and calls the Tauri command `send_screen_frame`.

Receiver side:

- The backend accepts a special `__SCREENCAST__` stream prefix and forwards
	incoming frames as `screen-cast-frame` events to the frontend.
- The React UI listens for `screen-cast-frame` and displays the JPEG frames in
	a live preview area.

Limitations & notes

- `getDisplayMedia()` must be supported by the WebView/host environment. On some
	platforms (especially certain Android WebViews) this may not be available.
- The implementation sends full JPEG frames periodically (default ~2 fps). This
	is simple and robust but not bandwidth-efficient; adjust the capture interval
	or encoding quality in `src/App.jsx` if needed.
- Screen casting requires a stable network path between sender and receiver and
	uses the same IP/port discovery flow as file transfers.

## Configuration & internals

- `src/App.jsx` — React UI and client-side logic (send, receive, screen capture)
- `src-tauri/src/lib.rs` — Rust backend: server, TCP handler, hotspot, BLE (Linux)
- `src-tauri/Cargo.toml` — Rust dependencies (note: `base64` added for frame encoding)
- Android-specific project: `src-tauri/gen/android`

Special wire protocol details for screen casting

- A sender may initiate a stream identified by the special filename `__SCREENCAST__`.
	After that marker the backend expects repeated u32 frame lengths followed by
	raw JPEG bytes; each frame is forwarded to the UI as a base64-encoded payload.

## Troubleshooting

- "No Wi‑Fi interface found": hotspot creation uses `nmcli` on Linux. Ensure
	NetworkManager controls your interface or create the hotspot manually.
- BLE advertising may fail if the machine has no Bluetooth hardware or permissions.
- If the frontend shows "Screen capture is not supported", check whether the
	WebView or browser supports `getDisplayMedia()`.

## Contributing

Contributions, bug reports and improvements are welcome. Suggested starting
points:

- Add more efficient screen streaming (WebRTC, video codec) for better latency.
- Add authentication/ACL for transfers if you plan to use the app on untrusted
	networks.

Open an issue or PR with a short description of the change and a small test.

## License

This repository has no license file by default. If you want a permissive license,
consider adding an `MIT` or `Apache-2.0` license file in the repo root.

---

If you'd like, I can also:

- Add a short developer checklist to `CONTRIBUTING.md`.
- Add a quick demo GIF or screenshots to the `public/` folder and link them here.
- Tune the screen-cast capture interval and encoding settings for better quality.

Which would you like next?

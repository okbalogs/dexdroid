import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import QRCode from "qrcode";
import "./App.css";

function formatBytes(bytes) {
  if (bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function TransferBar({ filename, transferred, total }) {
  const pct = total > 0 ? Math.round((transferred / total) * 100) : 0;
  return (
    <div className="transfer-card">
      <div className="transfer-header">
        <span className="transfer-name">{filename}</span>
        <span className="transfer-pct">{total > 0 ? `${pct}%` : "…"}</span>
      </div>
      <div className="progress-track">
        {total > 0
          ? <div className="progress-fill" style={{ width: `${pct}%` }} />
          : <div className="progress-fill indeterminate" />}
      </div>
      <span className="transfer-bytes">{formatBytes(transferred)} / {formatBytes(total)}</span>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("receive");

  // Receive / server state
  const [serverRunning, setServerRunning] = useState(false);
  const [serverPort, setServerPort] = useState(null);
  const [localIp, setLocalIp] = useState("");
  const [bleAdvertising, setBleAdvertising] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [receivedFiles, setReceivedFiles] = useState([]);

  // Hotspot state
  const [hotspotActive, setHotspotActive] = useState(false);
  const [hotspotInfo, setHotspotInfo] = useState(null); // { ssid, password, ip, port }
  const [hotspotBusy, setHotspotBusy] = useState(false);

  // Send state
  const [peerIp, setPeerIp] = useState("");
  const [peerPort, setPeerPort] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const [screenCastActive, setScreenCastActive] = useState(false);
  const [screenCastError, setScreenCastError] = useState("");
  const [screenCastImage, setScreenCastImage] = useState("");
  const screenCastRef = useRef({ stream: null, video: null, canvas: null, timer: null });

  // BLE scan state (mobile)
  const [bleScanning, setBleScanning] = useState(false);
  const [foundPeer, setFoundPeer] = useState(null);

  // Transfers keyed by filename
  const [transfers, setTransfers] = useState({});

  // ── Event listeners ──────────────────────────────────────────────────────────

  useEffect(() => {
    invoke("get_local_ip").then(ip => setLocalIp(ip));

    const subs = [
      listen("server-status", ({ payload }) => {
        setServerRunning(payload.running);
        if (!payload.running) { setServerPort(null); setQrDataUrl(""); setBleAdvertising(false); }
        else if (payload.port) setServerPort(payload.port);
      }),

      listen("ble-status", ({ payload }) => {
        if ("advertising" in payload) setBleAdvertising(payload.advertising);
        if ("scanning" in payload) setBleScanning(payload.scanning);
      }),

      listen("ble-device-found", ({ payload }) => {
        setFoundPeer(payload);
        setPeerIp(payload.ip);
        setPeerPort(String(payload.port));
        setBleScanning(false);
        setTab("send");
      }),

      listen("hotspot-status", ({ payload }) => {
        setHotspotActive(payload.active);
        if (payload.active) setHotspotInfo(payload);
        else setHotspotInfo(null);
      }),

      listen("transfer-progress", ({ payload }) => {
        setTransfers(prev => ({ ...prev, [payload.filename]: payload }));
      }),

      listen("file-received", ({ payload }) => {
        setReceivedFiles(prev => [payload, ...prev]);
        setTimeout(() => clearTransfer(payload.filename), 1200);
      }),

      listen("transfer-complete", ({ payload }) => {
        setSending(false);
        setTimeout(() => clearTransfer(payload.filename), 1200);
      }),

      listen("screen-cast-frame", ({ payload }) => {
        if (payload?.data) {
          setScreenCastImage(`data:image/jpeg;base64,${payload.data}`);
        }
      }),

      listen("screen-cast-ended", () => {
        setScreenCastImage("");
      }),
    ];

    return () => subs.forEach(p => p.then(fn => fn()));
  }, []);

  function clearTransfer(name) {
    setTransfers(prev => { const n = { ...prev }; delete n[name]; return n; });
  }

  // ── QR code ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const ip   = hotspotActive && hotspotInfo ? hotspotInfo.ip : localIp;
    const port = hotspotActive && hotspotInfo ? hotspotInfo.port : serverPort;
    if (!serverRunning || !port || !ip) { setQrDataUrl(""); return; }

    QRCode.toDataURL(`dexdroid://${ip}:${port}`, {
      width: 150, margin: 1,
      color: { dark: "#ededed", light: "#1c1c1c" },
    }).then(setQrDataUrl);
  }, [serverRunning, serverPort, localIp, hotspotActive, hotspotInfo]);

  // ── Actions ───────────────────────────────────────────────────────────────────

  async function toggleServer() {
    if (serverRunning) {
      await invoke("stop_server");
    } else {
      try { await invoke("start_server"); } catch (e) { console.error(e); }
    }
  }

  async function toggleHotspot() {
    setHotspotBusy(true);
    try {
      if (hotspotActive) {
        await invoke("stop_hotspot");
      } else {
        const info = await invoke("start_hotspot");
        setHotspotInfo(info);
        setHotspotActive(true);
      }
    } catch (e) {
      console.error("Hotspot error:", e);
    } finally {
      setHotspotBusy(false);
    }
  }

  async function requestBlePerms() {
    try { await invoke("request_ble_permissions"); } catch (_) {}
  }

  async function toggleBleScan() {
    if (bleScanning) {
      await invoke("stop_ble_scan");
    } else {
      setFoundPeer(null);
      try { await invoke("start_ble_scan"); } catch (e) { console.error(e); }
    }
  }

  async function connectHotspot() {
    if (!hotspotInfo) return;
    try {
      await invoke("connect_to_hotspot", { ssid: hotspotInfo.ssid, password: hotspotInfo.password });
    } catch (e) { console.error(e); }
  }

  async function pickFile() {
    const path = await open({ multiple: false, directory: false });
    if (path) setSelectedFile({ path, name: String(path).split(/[\\/]/).pop() });
  }

  async function handleSend() {
    if (!selectedFile || !peerIp || !peerPort) return;
    setSendError(""); setSending(true);
    try {
      await invoke("send_file", {
        peer_ip: peerIp,
        peer_port: parseInt(peerPort, 10),
        file_path: selectedFile.path,
      });
    } catch (e) {
      setSendError(String(e));
      setSending(false);
    }
  }

  async function startScreenCast() {
    setScreenCastError("");
    if (!peerIp || !peerPort) {
      setScreenCastError("Please enter a peer IP and port first.");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setScreenCastError("Screen capture is not supported in this environment.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;

      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve(undefined);
        video.onerror = () => reject(new Error("Unable to prepare screen capture video."));
      });
      await video.play();

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;

      await invoke("start_screen_cast", {
        peer_ip: peerIp,
        peer_port: parseInt(peerPort, 10),
      });

      const captureFrame = async () => {
        try {
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.65);
          const frameData = dataUrl.split(",")[1];
          await invoke("send_screen_frame", { frame_data: frameData });
        } catch (err) {
          console.error("Screen cast frame error:", err);
        }
      };

      const timer = window.setInterval(captureFrame, 500);
      screenCastRef.current = { stream, video, canvas, timer };
      setScreenCastActive(true);
    } catch (e) {
      setScreenCastError(String(e));
      await stopScreenCast();
    }
  }

  async function stopScreenCast() {
    const current = screenCastRef.current;
    if (current.timer) {
      window.clearInterval(current.timer);
    }
    if (current.stream) {
      current.stream.getTracks().forEach(track => track.stop());
    }
    screenCastRef.current = { stream: null, video: null, canvas: null, timer: null };
    setScreenCastActive(false);
    await invoke("stop_screen_cast").catch(() => {});
  }

  const activeTransfers = Object.values(transfers);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <header>
        <span className="logo-text">Dexdroid</span>
        <span className="tagline">Offline P2P Transfer</span>
      </header>

      <nav>
        <button className={tab === "receive" ? "active" : ""} onClick={() => setTab("receive")}>Receive</button>
        <button className={tab === "send" ? "active" : ""} onClick={() => setTab("send")}>Send</button>
      </nav>

      {/* ── RECEIVE ── */}
      {tab === "receive" && (
        <main>
          {/* Normal server (BLE + same-network) */}
          <button className={`btn-primary ${serverRunning && !hotspotActive ? "danger" : ""}`}
            onClick={toggleServer} disabled={hotspotActive}>
            {serverRunning && !hotspotActive ? "Stop" : "Start Receiving"}
          </button>

          {serverRunning && !hotspotActive && serverPort && (
            <div className="addr-card">
              <div className="addr-left">
                <span className="pulse" />
                <div>
                  <div className="addr">{localIp}:{serverPort}</div>
                  <div className="addr-hint">
                    {bleAdvertising ? "BLE beacon active · " : ""}Share this address with sender
                  </div>
                </div>
              </div>
              {qrDataUrl && (
                <div className="qr-wrap">
                  <img src={qrDataUrl} alt="QR" className="qr-img" />
                  <div className="qr-hint">Scan to connect</div>
                </div>
              )}
            </div>
          )}

          {/* Hotspot mode */}
          <div className="divider"><span>offline mode</span></div>

          <button
            className={`btn-primary ${hotspotActive ? "danger" : "secondary"}`}
            onClick={toggleHotspot}
            disabled={hotspotBusy || (serverRunning && !hotspotActive)}
          >
            {hotspotBusy ? "Working…" : hotspotActive ? "Stop Hotspot" : "Create Wi-Fi Hotspot"}
          </button>

          {hotspotActive && hotspotInfo && (
            <div className="hotspot-card">
              <div className="hotspot-row">
                <span className="hotspot-label">Network</span>
                <span className="hotspot-val">{hotspotInfo.ssid}</span>
              </div>
              <div className="hotspot-row">
                <span className="hotspot-label">Password</span>
                <span className="hotspot-val mono">{hotspotInfo.password}</span>
              </div>
              <div className="hotspot-row">
                <span className="hotspot-label">Address</span>
                <span className="hotspot-val mono">{hotspotInfo.ip}:{hotspotInfo.port}</span>
              </div>
              {qrDataUrl && (
                <div className="hotspot-qr">
                  <img src={qrDataUrl} alt="QR" className="qr-img" />
                  <div className="qr-hint">
                    1 — Join "{hotspotInfo.ssid}" · 2 — Scan QR in Dexdroid
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTransfers.filter(t => t.direction === "receive")
            .map(t => <TransferBar key={t.filename} {...t} />)}

          {screenCastImage && (
            <section className="screen-cast-view">
              <h4>Live screen cast</h4>
              <img src={screenCastImage} alt="Screen cast preview" />
            </section>
          )}

          {receivedFiles.length > 0 && (
            <section className="history">
              <h4>Received</h4>
              {receivedFiles.map((f, i) => (
                <div key={i} className="history-row">
                  <span className="history-name">{f.filename}</span>
                  <span className="history-size">{formatBytes(f.size)}</span>
                </div>
              ))}
            </section>
          )}
        </main>
      )}

      {/* ── SEND ── */}
      {tab === "send" && (
        <main>
          <button className="btn-primary secondary" onClick={requestBlePerms}>
            Allow BLE (first time only)
          </button>

          <button
            className={`btn-primary ${bleScanning ? "danger" : "secondary"}`}
            onClick={toggleBleScan} disabled={sending}
          >
            {bleScanning ? "Stop Scanning…" : "Scan for PC via BLE"}
          </button>

          {bleScanning && <div className="scan-hint">Searching for nearby Dexdroid hosts…</div>}

          {foundPeer && (
            <div className="found-peer">
              <span className="pulse green" />
              <span>Found <strong>{foundPeer.name}</strong> — {foundPeer.ip}:{foundPeer.port}</span>
            </div>
          )}

          <div className="divider"><span>or enter manually</span></div>

          <label className="field">
            <span>Peer IP</span>
            <input value={peerIp} onChange={e => setPeerIp(e.target.value)} placeholder="192.168.x.x" />
          </label>

          <label className="field">
            <span>Port</span>
            <input value={peerPort} onChange={e => setPeerPort(e.target.value)} placeholder="e.g. 52341" type="number" />
          </label>

          <div className="field">
            <span>File</span>
            <div className="file-row">
              <button className="btn-secondary" onClick={pickFile}>Browse</button>
              <span className="file-label">{selectedFile ? selectedFile.name : "No file selected"}</span>
            </div>
          </div>

          <button className="btn-primary" onClick={handleSend}
            disabled={!selectedFile || !peerIp || !peerPort || sending || screenCastActive}>
            {sending ? "Sending…" : "Send"}
          </button>

          <button
            className={`btn-primary ${screenCastActive ? "danger" : "secondary"}`}
            onClick={screenCastActive ? stopScreenCast : startScreenCast}
            disabled={!peerIp || !peerPort || sending}
          >
            {screenCastActive ? "Stop Screen Cast" : "Start Screen Cast"}
          </button>

          {screenCastError && <div className="error">{screenCastError}</div>}

          {sendError && <div className="error">{sendError}</div>}

          {activeTransfers.filter(t => t.direction === "send")
            .map(t => <TransferBar key={t.filename} {...t} />)}
        </main>
      )}
    </div>
  );
}

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CHUNK: usize = 64 * 1024;

// Wire protocol (little-endian):
//   [u32 filename_len][filename bytes][u64 file_size][file bytes...]

// ── Managed state ─────────────────────────────────────────────────────────────

pub struct TransferServer {
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    port: Mutex<Option<u16>>,
}

impl Default for TransferServer {
    fn default() -> Self {
        Self {
            shutdown_tx: Mutex::new(None),
            port: Mutex::new(None),
        }
    }
}

pub struct BleState {
    #[cfg(target_os = "linux")]
    handle: Mutex<Option<bluer::adv::AdvertisementHandle>>,
}

impl Default for BleState {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            handle: Mutex::new(None),
        }
    }
}

pub struct HotspotState {
    active: Mutex<bool>,
}

impl Default for HotspotState {
    fn default() -> Self {
        Self {
            active: Mutex::new(false),
        }
    }
}

// ── BLE advertising (Linux only) ─────────────────────────────────────────────

#[cfg(target_os = "linux")]
const SERVICE_UUID: bluer::Uuid =
    bluer::Uuid::from_u128(0x6de4000100001000800000805f9b34fb_u128);

#[cfg(target_os = "linux")]
async fn ble_start(ip: &str, port: u16) -> Result<bluer::adv::AdvertisementHandle, String> {
    use std::collections::{BTreeMap, BTreeSet};

    let parts: Vec<u8> = ip
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() != 4 {
        return Err("Invalid IP address".into());
    }

    let session = bluer::Session::new().await.map_err(|e| e.to_string())?;
    let adapter = session.default_adapter().await.map_err(|e| e.to_string())?;
    adapter.set_powered(true).await.map_err(|e| e.to_string())?;

    let mut svc_data = BTreeMap::new();
    svc_data.insert(
        SERVICE_UUID,
        vec![parts[0], parts[1], parts[2], parts[3], (port & 0xff) as u8, (port >> 8) as u8],
    );

    let adv = bluer::adv::Advertisement {
        advertisement_type: bluer::adv::Type::Peripheral,
        local_name: Some("Dexdroid".to_string()),
        service_uuids: BTreeSet::from([SERVICE_UUID]),
        service_data: svc_data,
        discoverable: Some(true),
        ..Default::default()
    };

    adapter.advertise(adv).await.map_err(|e| e.to_string())
}

// ── Hotspot (Linux only) ──────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
const HOTSPOT_CON: &str = "dexdroid-ap";
#[cfg(target_os = "linux")]
const HOTSPOT_IP: &str = "10.42.0.1";

#[cfg(target_os = "linux")]
async fn wifi_iface() -> Option<String> {
    let out = tokio::process::Command::new("nmcli")
        .args(["-t", "-f", "DEVICE,TYPE", "device"])
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| {
            let mut p = line.splitn(2, ':');
            let dev = p.next()?;
            let typ = p.next()?;
            if typ == "wifi" { Some(dev.to_string()) } else { None }
        })
}

// Generate an 8-char hex password that's unique per process launch
fn gen_password() -> String {
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:04x}{:04x}", ns & 0xffff, std::process::id() & 0xffff)
}

// ── Inner server start (shared by start_server and start_hotspot) ─────────────

async fn bind_server(
    server: &TransferServer,
    app: &AppHandle,
    ble: &BleState,
    advertise_ip: &str,
) -> Result<u16, String> {
    // Stop any running server
    {
        let mut tx = server.shutdown_tx.lock().unwrap();
        if let Some(s) = tx.take() { let _ = s.send(()); }
    }

    let listener = TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    {
        let mut p = server.port.lock().unwrap();
        *p = Some(port);
    }

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut tx = server.shutdown_tx.lock().unwrap();
        *tx = Some(shutdown_tx);
    }

    let app_spawn = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, _)) => {
                            let a = app_spawn.clone();
                            tokio::spawn(handle_incoming(stream, a));
                        }
                        Err(e) => eprintln!("Accept error: {e}"),
                    }
                }
                _ = &mut shutdown_rx => {
                    let _ = app_spawn.emit("server-status", serde_json::json!({ "running": false }));
                    break;
                }
            }
        }
    });

    // BLE advertising
    #[cfg(target_os = "linux")]
    match ble_start(advertise_ip, port).await {
        Ok(h) => {
            *ble.handle.lock().unwrap() = Some(h);
            let _ = app.emit("ble-status", serde_json::json!({ "advertising": true }));
        }
        Err(e) => {
            eprintln!("BLE advertising failed (no BT hardware?): {e}");
            let _ = app.emit("ble-status", serde_json::json!({ "advertising": false, "error": e }));
        }
    }

    let _ = app.emit("server-status", serde_json::json!({ "running": true, "port": port }));
    Ok(port)
}

// ── TCP receive handler ───────────────────────────────────────────────────────

async fn handle_incoming(mut stream: TcpStream, app: AppHandle) {
    let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
        let name_len = stream.read_u32_le().await? as usize;
        let mut name_buf = vec![0u8; name_len];
        stream.read_exact(&mut name_buf).await?;
        let filename = String::from_utf8(name_buf)?;
        let file_size = stream.read_u64_le().await?;

        let save_dir = dirs::download_dir()
            .or_else(|| dirs::home_dir())
            .unwrap_or_else(|| PathBuf::from("."));
        let save_path = save_dir.join(&filename);

        let mut file = tokio::fs::File::create(&save_path).await?;
        let mut received: u64 = 0;
        let mut buf = vec![0u8; CHUNK];

        while received < file_size {
            let to_read = ((file_size - received) as usize).min(CHUNK);
            let n = stream.read(&mut buf[..to_read]).await?;
            if n == 0 { break; }
            file.write_all(&buf[..n]).await?;
            received += n as u64;

            let _ = app.emit("transfer-progress", serde_json::json!({
                "direction": "receive",
                "filename": &filename,
                "transferred": received,
                "total": file_size,
            }));
        }

        file.flush().await?;
        let _ = app.emit("file-received", serde_json::json!({
            "filename": &filename,
            "path": save_path.to_string_lossy(),
            "size": file_size,
        }));
        Ok(())
    }.await;

    if let Err(e) = result { eprintln!("Transfer error: {e}"); }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_local_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .ok()
        .and_then(|s| { s.connect("8.8.8.8:80").ok()?; s.local_addr().ok() })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

#[tauri::command]
async fn start_server(
    app: AppHandle,
    server: State<'_, TransferServer>,
    ble: State<'_, BleState>,
) -> Result<u16, String> {
    let ip = get_local_ip();
    bind_server(&server, &app, &ble, &ip).await
}

#[tauri::command]
async fn stop_server(
    server: State<'_, TransferServer>,
    ble: State<'_, BleState>,
) -> Result<(), String> {
    let mut tx = server.shutdown_tx.lock().unwrap();
    if let Some(s) = tx.take() { let _ = s.send(()); }
    *server.port.lock().unwrap() = None;

    #[cfg(target_os = "linux")]
    { *ble.handle.lock().unwrap() = None; }

    Ok(())
}

#[tauri::command]
async fn send_file(
    app: AppHandle,
    peer_ip: String,
    peer_port: u16,
    file_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    let filename = path.file_name().ok_or("Invalid file path")?.to_string_lossy().to_string();
    let metadata = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    let file_size = metadata.len();

    let addr = format!("{peer_ip}:{peer_port}");
    let mut stream = TcpStream::connect(&addr).await
        .map_err(|e| format!("Cannot reach {addr}: {e}"))?;

    let name_bytes = filename.as_bytes();
    stream.write_u32_le(name_bytes.len() as u32).await.map_err(|e| e.to_string())?;
    stream.write_all(name_bytes).await.map_err(|e| e.to_string())?;
    stream.write_u64_le(file_size).await.map_err(|e| e.to_string())?;

    let mut file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let mut sent: u64 = 0;
    let mut buf = vec![0u8; CHUNK];

    loop {
        let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        stream.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        sent += n as u64;

        let _ = app.emit("transfer-progress", serde_json::json!({
            "direction": "send", "filename": &filename,
            "transferred": sent, "total": file_size,
        }));
    }

    stream.flush().await.map_err(|e| e.to_string())?;
    let _ = app.emit("transfer-complete", serde_json::json!({
        "direction": "send", "filename": &filename, "size": file_size,
    }));
    Ok(())
}

// ── Hotspot commands (desktop-only) ──────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct HotspotInfo {
    ssid: String,
    password: String,
    ip: String,
    port: u16,
}

#[tauri::command]
async fn start_hotspot(
    app: AppHandle,
    server: State<'_, TransferServer>,
    ble: State<'_, BleState>,
    hotspot: State<'_, HotspotState>,
) -> Result<HotspotInfo, String> {
    #[cfg(target_os = "linux")]
    {
        let password = gen_password();
        let ssid = "Dexdroid".to_string();

        let iface = wifi_iface().await.ok_or("No Wi-Fi interface found")?;

        // Remove any previous hotspot connection
        let _ = tokio::process::Command::new("nmcli")
            .args(["connection", "delete", HOTSPOT_CON])
            .status().await;

        let status = tokio::process::Command::new("nmcli")
            .args([
                "device", "wifi", "hotspot",
                "con-name", HOTSPOT_CON,
                "ifname", &iface,
                "ssid", &ssid,
                "password", &password,
            ])
            .status().await
            .map_err(|e| format!("nmcli error: {e}"))?;

        if !status.success() {
            return Err("Hotspot creation failed. Ensure NetworkManager controls the Wi-Fi interface.".into());
        }

        *hotspot.active.lock().unwrap() = true;

        // Bind server on hotspot IP (0.0.0.0 listens on all interfaces including AP)
        let port = bind_server(&server, &app, &ble, HOTSPOT_IP).await?;

        let info = HotspotInfo { ssid, password, ip: HOTSPOT_IP.to_string(), port };

        let _ = app.emit("hotspot-status", serde_json::json!({
            "active": true,
            "ssid": &info.ssid,
            "password": &info.password,
            "ip": &info.ip,
            "port": info.port,
        }));

        return Ok(info);
    }

    #[cfg(not(target_os = "linux"))]
    Err("Hotspot only supported on Linux".into())
}

#[tauri::command]
async fn stop_hotspot(
    app: AppHandle,
    hotspot: State<'_, HotspotState>,
    server: State<'_, TransferServer>,
    ble: State<'_, BleState>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = tokio::process::Command::new("nmcli")
            .args(["connection", "delete", HOTSPOT_CON])
            .status().await;

        *hotspot.active.lock().unwrap() = false;

        // Also stop the server
        let mut tx = server.shutdown_tx.lock().unwrap();
        if let Some(s) = tx.take() { let _ = s.send(()); }
        *server.port.lock().unwrap() = None;
        *ble.handle.lock().unwrap() = None;

        let _ = app.emit("hotspot-status", serde_json::json!({ "active": false }));
        let _ = app.emit("server-status", serde_json::json!({ "running": false }));
    }
    Ok(())
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(TransferServer::default())
        .manage(BleState::default())
        .manage(HotspotState::default())
        .invoke_handler(tauri::generate_handler![
            get_local_ip,
            start_server,
            stop_server,
            send_file,
            start_hotspot,
            stop_hotspot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

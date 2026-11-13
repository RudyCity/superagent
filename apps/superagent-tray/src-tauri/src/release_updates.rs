//! Verified, manual-only update discovery/download for SuperAgent Tray.
//! This is NOT the transactional local Tray slot upgrader. It never executes an
//! installer, changes a running service owner, or promotes a binary.
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const API: &str = "https://api.github.com/repos/RudyCity/superagent/releases?per_page=30";
const RELEASE_URL: &str = "https://github.com/RudyCity/superagent/releases/tag/";
const MAX_MANIFEST: usize = 32 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_BINARY: u64 = 700 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}
#[derive(Debug, Deserialize)]
struct ReleaseRecord {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseUpdateStatus {
    current_version: String,
    installed_release_tag: Option<String>,
    release_version: String,
    tag: String,
    release_url: String,
    platform: String,
    state: String,
    asset_name: Option<String>,
    asset_size: Option<u64>,
    sha256: Option<String>,
    components: Vec<String>,
    download_supported: bool,
    component_items: Vec<UpdateComponent>,
    note: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedDownload {
    file_path: String,
    file_name: String,
    tag: String,
    sha256: String,
    bytes: u64,
    installed: bool,
    note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateComponent {
    id: String,
    label: String,
    version: String,
    installed_version: Option<String>,
    state: String,
    platform: String,
    file_name: Option<String>,
    size: Option<u64>,
    sha256: Option<String>,
    available: bool,
    instructions: String,
}

fn release_order(tag: &str) -> Option<(u64, u64, u64, u64)> {
    let value = tag.strip_prefix('v')?;
    let (version, rc) = value.split_once("-rc.")?;
    if rc.is_empty() || !rc.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let v: Vec<&str> = version.split('.').collect();
    if v.len() != 3
        || v.iter()
            .any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some((
        v[0].parse().ok()?,
        v[1].parse().ok()?,
        v[2].parse().ok()?,
        rc.parse().ok()?,
    ))
}
fn version_order(v: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}
fn latest<'a>(all: &'a [ReleaseRecord]) -> Option<&'a ReleaseRecord> {
    all.iter()
        .filter(|r| !r.draft && r.prerelease && release_order(&r.tag_name).is_some())
        .max_by_key(|r| release_order(&r.tag_name).unwrap())
}
fn release_state(
    installed_version: &str,
    release_version: &str,
    published_tag: &str,
    installed_tag: Option<&str>,
) -> &'static str {
    match version_order(installed_version)
        .zip(version_order(release_version))
        .map(|(installed, published)| installed.cmp(&published))
    {
        Some(std::cmp::Ordering::Less) => "update_available",
        Some(std::cmp::Ordering::Greater) => "installed_newer",
        Some(std::cmp::Ordering::Equal) => match installed_tag.and_then(release_order) {
            Some(installed) => match release_order(published_tag) {
                Some(published) if installed < published => "update_available",
                Some(published) if installed == published => "same_version",
                Some(published) if installed > published => "installed_newer",
                _ => "build_unverified",
            },
            None => "build_unverified",
        },
        None => "unknown_installed_version",
    }
}

fn target_package(os: &str, arch: &str, version: &str) -> Option<(String, String)> {
    match (os, arch) {
        ("windows", "x86_64") => Some((
            "Windows x64".into(),
            format!("SuperAgent_{version}_x64-setup.exe"),
        )),
        ("macos", "aarch64") => Some((
            "macOS Apple Silicon".into(),
            format!("SuperAgent_{version}_aarch64.dmg"),
        )),
        ("linux", "x86_64") => Some((
            "Linux x64".into(),
            format!("SuperAgent_{version}_amd64.AppImage"),
        )),
        _ => None,
    }
}
fn package_for_platform(version: &str) -> Option<(String, String)> {
    target_package(std::env::consts::OS, std::env::consts::ARCH, version)
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && !name.contains("..")
}
fn validate_asset_url(tag: &str, asset: &ReleaseAsset) -> Result<(), String> {
    if !valid_name(&asset.name) {
        return Err("UPDATE_ASSET_NAME_INVALID".into());
    }
    let expected = format!(
        "https://github.com/RudyCity/superagent/releases/download/{tag}/{}",
        asset.name
    );
    if asset.browser_download_url != expected {
        return Err("UPDATE_ASSET_ORIGIN_MISMATCH".into());
    }
    Ok(())
}
fn sha256_for_file(manifest: &str, file: &str) -> Result<String, String> {
    let mut matches = Vec::new();
    for line in manifest.lines() {
        let mut parts = line.splitn(2, char::is_whitespace);
        let Some(hash) = parts.next() else { continue };
        let Some(rest) = parts.next() else { continue };
        let raw = rest.trim();
        let entry = raw.strip_prefix('*').unwrap_or(raw);
        if entry == file || entry == format!("./{file}") {
            // Even a malformed second matching row counts as an ambiguous/
            // unsafe manifest. Never quietly ignore it.
            if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("UPDATE_CHECKSUM_MALFORMED".into());
            }
            matches.push(hash.to_ascii_lowercase());
        }
    }
    if matches.len() != 1 {
        return Err("UPDATE_CHECKSUM_MISSING_OR_DUPLICATE".into());
    }
    Ok(matches.remove(0))
}
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(40))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("update redirect limit");
            }
            let url = attempt.url();
            let host = url.host_str().unwrap_or("");
            if url.scheme() == "https"
                && matches!(
                    host,
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            {
                attempt.follow()
            } else {
                attempt.error("untrusted update redirect")
            }
        }))
        .build()
        .map_err(|_| "UPDATE_CLIENT_UNAVAILABLE".to_string())
}
async fn bounded_get(client: &Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .header("User-Agent", "SuperAgent-Update-Checker")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "UPDATE_FETCH_FAILED")?;
    if !response.status().is_success() {
        return Err("UPDATE_HTTP_ERROR".into());
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("UPDATE_RESPONSE_TOO_LARGE".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "UPDATE_READ_ERROR")? {
        if data.len() + chunk.len() > limit {
            return Err("UPDATE_RESPONSE_TOO_LARGE".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
fn catalog(release: &ReleaseRecord) -> Vec<String> {
    // The UI only displays recognized filenames; it never executes or opens
    // a URL provided by the metadata.
    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or("")
        .split("-rc.")
        .next()
        .unwrap_or("");
    let variants = [
        (
            "Windows installer",
            format!("SuperAgent_{version}_x64-setup.exe"),
        ),
        ("macOS DMG", format!("SuperAgent_{version}_aarch64.dmg")),
        ("Linux DEB", format!("SuperAgent_{version}_amd64.deb")),
        (
            "Linux AppImage",
            format!("SuperAgent_{version}_amd64.AppImage"),
        ),
    ];
    let mut names: Vec<String> = variants
        .into_iter()
        .filter(|(_, name)| release.assets.iter().any(|a| a.name == *name))
        .map(|(label, _)| label.to_string())
        .collect();
    for (label, needle) in [
        ("Chrome Delegate", "superagent-delegate-"),
        ("Chrome SidePanel", "superagent-sidepanel-"),
        ("Windows LAN preview", "SuperAgent-LAN-Client-"),
        ("Android LAN preview", "SuperAgent-LAN-Android-"),
    ] {
        if release.assets.iter().any(|a| {
            a.name.starts_with(needle)
                && valid_name(&a.name)
                && (a.name.ends_with(".zip")
                    || a.name.ends_with(".exe")
                    || a.name.ends_with(".apk"))
        }) {
            names.push(label.to_string());
        }
    }
    names
}
// A release may contain different component versions. Never infer the
// installed extension / phone / LAN receiver version from the Tray version.
fn versioned_asset(
    release: &ReleaseRecord,
    prefix: &str,
    suffix: &str,
) -> Result<Option<(String, String)>, String> {
    let mut found = Vec::new();
    for asset in &release.assets {
        let Some(version) = asset
            .name
            .strip_prefix(prefix)
            .and_then(|name| name.strip_suffix(suffix))
        else {
            continue;
        };
        if version.is_empty()
            || version.len() > 64
            || !version
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'.' || ch == b'-')
            || !version.starts_with(|ch: char| ch.is_ascii_digit())
        {
            return Err("UPDATE_COMPONENT_VERSION_INVALID".into());
        }
        found.push((asset.name.clone(), version.to_string()));
    }
    if found.len() > 1 {
        return Err("UPDATE_COMPONENT_AMBIGUOUS".into());
    }
    Ok(found.pop())
}

fn component_catalog(
    release: &ReleaseRecord,
    manifest: &str,
    current_version: &str,
    release_version: &str,
) -> Result<Vec<UpdateComponent>, String> {
    // Deliberately finite allowlist: no arbitrary file naming, custom URL,
    // remote instructions, or file execution is ever accepted.
    let platform = package_for_platform(release_version);
    let core = platform
        .as_ref()
        .map(|(_, name)| (name.clone(), release_version.to_string()));
    let core_filename = core.as_ref().map(|x| x.0.clone());
    // Native installers for OTHER computers are downloadable for transfer,
    // not installable on this host. The current host installer is listed once.
    let windows = Some((
        format!("SuperAgent_{release_version}_x64-setup.exe"),
        release_version.to_string(),
    ));
    let macos = Some((
        format!("SuperAgent_{release_version}_aarch64.dmg"),
        release_version.to_string(),
    ));
    let appimage = Some((
        format!("SuperAgent_{release_version}_amd64.AppImage"),
        release_version.to_string(),
    ));
    let deb = Some((
        format!("SuperAgent_{release_version}_amd64.deb"),
        release_version.to_string(),
    ));
    let delegate = versioned_asset(release, "superagent-delegate-", ".zip")?;
    let sidepanel = versioned_asset(release, "superagent-sidepanel-", ".zip")?;
    let android = versioned_asset(release, "SuperAgent-LAN-Android-", "-debug.apk")?;
    let lan = versioned_asset(release, "SuperAgent-LAN-Client-", "-Windows-x64-setup.exe")?;
    let core_state = release_state(
        current_version,
        release_version,
        &release.tag_name,
        option_env!("SUPERAGENT_RELEASE_TAG"),
    );
    let candidates = vec![
        ("superagent", "SuperAgent Tray + Core + CLI", core,
            platform.as_ref().map(|p|p.0.as_str()).unwrap_or("Unsupported architecture"),
            "Close the Tray only when ready. Open the verified installer manually; running Core and MCP ownership are not migrated automatically.",
            Some(current_version), core_state),
        ("windows-installer", "Windows standalone installer", windows,
            "Windows x64 (transferable)", "Run manually on the target Windows PC. The standalone installer already bundles Bun, Core and CLI; do not use bun install -g.",
            None, "installed_unknown"),
        ("macos-dmg", "macOS Apple Silicon DMG", macos,
            "macOS ARM64 (transferable)", "Open the verified DMG manually on an Apple Silicon Mac; prerelease is not notarized and may need explicit Gatekeeper approval.",
            None, "installed_unknown"),
        ("linux-appimage", "Linux AppImage", appimage,
            "Linux x64 (transferable)", "On the Linux machine, make the verified AppImage executable and launch it manually after checking running services.",
            None, "installed_unknown"),
        ("linux-deb", "Linux Debian/Ubuntu DEB", deb,
            "Linux x64 (transferable)", "Install the verified DEB manually with your OS package manager after checking active workloads; no remote root command is executed.",
            None, "installed_unknown"),
        ("chrome-delegate", "Chrome Delegate Extension", delegate,
            "Chrome (all desktop OS)", "Unzip the archive. In chrome://extensions enable Developer mode, then Load unpacked (or update/reload the existing unpacked extension) after active delegated sessions are finished.",
            None, "installed_unknown"),
        ("chrome-sidepanel", "Chrome SidePanel Extension", sidepanel,
            "Chrome (all desktop OS)", "Unzip the archive and load/reload it from chrome://extensions using Developer mode. Chrome Web Store installations have a separate store-managed update path.",
            None, "installed_unknown"),
        ("android-lan", "Android LAN Client", android,
            "Android (APK transferable from desktop)", "Transfer the verified APK to the phone and approve installation on the Android device. This is a debug-signed preview: different signing keys may require reinstall and risk local data.",
            None, "installed_unknown"),
        ("windows-lan", "Windows LAN Receiver GUI", lan,
            "Windows x64 (transferable from other OS)", "Run the verified Windows LAN installer manually on a standard, non-elevated Windows session after active transfers finish. Pairing requires fresh device-owner approval.",
            None, "installed_unknown"),
    ];
    let mut result = Vec::with_capacity(candidates.len());
    for (id, label, candidate, os, instructions, installed, state) in candidates {
        if id != "superagent"
            && candidate.as_ref().map(|x| x.0.as_str()) == core_filename.as_deref()
        {
            continue;
        }
        let mut size = None;
        let mut sha = None;
        let mut name = None;
        let mut version = String::new();
        if let Some((filename, published_version)) = candidate {
            // Exact release filenames only; multiple names would fail above.
            let matching: Vec<&ReleaseAsset> = release
                .assets
                .iter()
                .filter(|asset| asset.name == filename)
                .collect();
            if matching.len() > 1 {
                return Err("UPDATE_ASSET_DUPLICATE".into());
            }
            if let Some(asset) = matching.first() {
                let minimum = if filename.ends_with(".zip") {
                    1000
                } else if filename.ends_with(".apk") {
                    1_000_000
                } else {
                    20_000_000
                };
                if asset.size < minimum || asset.size > MAX_BINARY {
                    return Err("UPDATE_ASSET_SIZE_INVALID".into());
                }
                validate_asset_url(&release.tag_name, asset)?;
                sha = Some(sha256_for_file(manifest, &filename)?);
                size = Some(asset.size);
                name = Some(filename);
                version = published_version;
            }
        }
        result.push(UpdateComponent {
            id: id.to_string(),
            label: label.to_string(),
            version,
            installed_version: installed.map(str::to_string),
            state: if name.is_none() {
                "unavailable".into()
            } else {
                state.into()
            },
            platform: os.to_string(),
            file_name: name.clone(),
            size,
            sha256: sha,
            available: name.is_some(),
            instructions: instructions.to_string(),
        });
    }
    Ok(result)
}

async fn resolve(
    client: &Client,
    current_version: String,
) -> Result<(ReleaseUpdateStatus, Vec<ReleaseAsset>), String> {
    let bytes = bounded_get(client, API, MAX_RESPONSE).await?;
    let releases: Vec<ReleaseRecord> =
        serde_json::from_slice(&bytes).map_err(|_| "UPDATE_RELEASE_METADATA_INVALID")?;
    let release = latest(&releases).ok_or("UPDATE_NO_VERIFIED_RELEASE")?;
    let order = release_order(&release.tag_name).ok_or("UPDATE_TAG_INVALID")?;
    let version = format!("{}.{}.{}", order.0, order.1, order.2);
    let checksum = release
        .assets
        .iter()
        .find(|a| a.name == "SHA256SUMS.txt")
        .ok_or("UPDATE_CHECKSUM_ASSET_MISSING")?;
    validate_asset_url(&release.tag_name, checksum)?;
    if checksum.size < 100 || checksum.size > MAX_MANIFEST as u64 {
        return Err("UPDATE_CHECKSUM_SIZE_INVALID".into());
    }
    let manifest = bounded_get(client, &checksum.browser_download_url, MAX_MANIFEST).await?;
    let manifest = std::str::from_utf8(&manifest).map_err(|_| "UPDATE_CHECKSUM_ENCODING")?;
    let component_items = component_catalog(&release, manifest, &current_version, &version)?;
    let primary = component_items
        .iter()
        .find(|item| item.id == "superagent")
        .ok_or("UPDATE_CORE_COMPONENT_MISSING")?;
    let platform = package_for_platform(&version);
    let state = primary.state.clone();
    let asset_name = primary.file_name.clone();
    let asset_size = primary.size;
    let sha256 = primary.sha256.clone();
    let download_supported = primary.available;
    Ok((ReleaseUpdateStatus {
        current_version,installed_release_tag:option_env!("SUPERAGENT_RELEASE_TAG").map(str::to_string),release_version:version,
        tag:release.tag_name.clone(),release_url:format!("{RELEASE_URL}{}",release.tag_name),
        platform:platform.map(|x|x.0).unwrap_or("Unsupported OS/architecture".into()),
        state,asset_name,asset_size,sha256,components:catalog(release),
        download_supported,component_items,
        note:"Verified official prerelease metadata and per-component SHA-256. Downloads are manual; installation, restart, rollback and Core/MCP ownership are unchanged.".into(),
    },release.assets.clone()))
}
impl Clone for ReleaseAsset {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            size: self.size,
            browser_download_url: self.browser_download_url.clone(),
        }
    }
}
fn safe_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        let info = fs::symlink_metadata(dir).map_err(|_| "UPDATE_DIRECTORY_UNAVAILABLE")?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return Err("UPDATE_DIRECTORY_UNSAFE".into());
        }
    } else {
        let parent = dir.parent().ok_or("UPDATE_DIRECTORY_INVALID")?;
        safe_dir(parent)?;
        fs::create_dir(dir).map_err(|_| "UPDATE_DIRECTORY_CREATE_FAILED")?;
    }
    Ok(())
}
fn local_download_directory() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("UPDATE_HOME_UNAVAILABLE")?;
    let folder = home.join("Downloads").join("SuperAgent").join("updates");
    safe_dir(&folder)?;
    Ok(folder)
}
fn verify_existing(path: &Path, sha: &str, size: u64) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "UPDATE_EXISTING_FILE_UNAVAILABLE")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != size {
        return Err("UPDATE_EXISTING_FILE_UNSAFE".into());
    }
    let mut f = File::open(path).map_err(|_| "UPDATE_EXISTING_FILE_UNREADABLE")?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let count = f
            .read(&mut buf)
            .map_err(|_| "UPDATE_EXISTING_FILE_UNREADABLE")?;
        if count == 0 {
            break;
        }
        digest.update(&buf[..count]);
    }
    if format!("{:x}", digest.finalize()) != sha {
        return Err("UPDATE_EXISTING_CHECKSUM_MISMATCH".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn check_release_updates(app: tauri::AppHandle) -> Result<ReleaseUpdateStatus, String> {
    let c = client()?;
    resolve(&c, app.package_info().version.to_string())
        .await
        .map(|x| x.0)
}
async fn download_verified_asset(
    c: &Client,
    asset: ReleaseAsset,
    expected_tag: String,
    expected_sha256: String,
) -> Result<VerifiedDownload, String> {
    let dest = local_download_directory()?.join(&asset.name);
    if dest.exists() {
        verify_existing(&dest, &expected_sha256.to_lowercase(), asset.size)?;
        return Ok(VerifiedDownload {
            file_path: dest.to_string_lossy().into_owned(),
            file_name: asset.name,
            tag: expected_tag,
            sha256: expected_sha256.to_lowercase(),
            bytes: asset.size,
            installed: false,
            note: "Existing file verified; not executed.".into(),
        });
    }
    let tmp = dest.with_file_name(format!("{}.{}.partial", asset.name, uuid::Uuid::new_v4()));
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|_| "UPDATE_TEMP_CREATE_FAILED")?;
    let result = async {
        let mut response = c
            .get(&asset.browser_download_url)
            .header("User-Agent", "SuperAgent-Verified-Updater")
            .send()
            .await
            .map_err(|_| "UPDATE_DOWNLOAD_FAILED")?;
        if !response.status().is_success() {
            return Err("UPDATE_DOWNLOAD_HTTP_ERROR".to_string());
        }
        let mut hash = Sha256::new();
        let mut total = 0u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "UPDATE_DOWNLOAD_STREAM_FAILED")?
        {
            total = total
                .checked_add(chunk.len() as u64)
                .ok_or("UPDATE_DOWNLOAD_TOO_LARGE")?;
            if total > asset.size || total > MAX_BINARY {
                return Err("UPDATE_DOWNLOAD_TOO_LARGE".into());
            }
            hash.update(&chunk);
            out.write_all(&chunk)
                .map_err(|_| "UPDATE_DOWNLOAD_WRITE_FAILED")?;
        }
        out.sync_all().map_err(|_| "UPDATE_DOWNLOAD_SYNC_FAILED")?;
        if total != asset.size || format!("{:x}", hash.finalize()) != expected_sha256.to_lowercase()
        {
            return Err("UPDATE_DOWNLOAD_HASH_OR_SIZE_MISMATCH".into());
        }
        Ok(())
    }
    .await;
    drop(out);
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if dest.exists() {
        let _ = fs::remove_file(&tmp);
        return Err("UPDATE_DOWNLOAD_DESTINATION_CHANGED".into());
    }
    // hard_link is atomic create-new on the same filesystem: never replace a
    // destination that another updater/actor created after the initial check.
    if let Err(_) = fs::hard_link(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err("UPDATE_DOWNLOAD_FINALIZE_FAILED".into());
    }
    fs::remove_file(&tmp).map_err(|_| "UPDATE_TEMP_CLEANUP_FAILED")?;
    Ok(VerifiedDownload {
        file_path: dest.to_string_lossy().into_owned(),
        file_name: asset.name,
        tag: expected_tag,
        sha256: expected_sha256.to_lowercase(),
        bytes: asset.size,
        installed: false,
        note: "SHA-256 verified. No installer was executed and no service was restarted.".into(),
    })
}
fn valid_confirmation(expected_tag: &str, expected_sha256: &str) -> Result<(), String> {
    if release_order(expected_tag).is_none()
        || expected_sha256.len() != 64
        || !expected_sha256.bytes().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err("UPDATE_CONFIRMATION_INVALID".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn download_release_update(
    app: tauri::AppHandle,
    expected_tag: String,
    expected_sha256: String,
) -> Result<VerifiedDownload, String> {
    download_release_component(app, "superagent".into(), expected_tag, expected_sha256).await
}

#[tauri::command]
pub async fn download_release_component(
    app: tauri::AppHandle,
    component_id: String,
    expected_tag: String,
    expected_sha256: String,
) -> Result<VerifiedDownload, String> {
    valid_confirmation(&expected_tag, &expected_sha256)?;
    // Client input is a finite component ID; never a path, URL, or filename.
    if !matches!(
        component_id.as_str(),
        "superagent"
            | "linux-deb"
            | "chrome-delegate"
            | "chrome-sidepanel"
            | "android-lan"
            | "windows-lan"
    ) {
        return Err("UPDATE_COMPONENT_NOT_ALLOWED".into());
    }
    let c = client()?;
    // Refetch authoritative release metadata and checksum at click time,
    // preventing stale/tampered UI fields from influencing selection.
    let (status, assets) = resolve(&c, app.package_info().version.to_string()).await?;
    let component = status
        .component_items
        .iter()
        .find(|item| item.id == component_id)
        .ok_or("UPDATE_COMPONENT_NOT_ALLOWED")?;
    if status.tag != expected_tag
        || !component.available
        || component.sha256.as_deref() != Some(&expected_sha256.to_ascii_lowercase())
    {
        return Err("UPDATE_RELEASE_CHANGED_SINCE_REVIEW".into());
    }
    let file = component
        .file_name
        .as_ref()
        .ok_or("UPDATE_PLATFORM_NOT_SUPPORTED")?;
    let asset = assets
        .into_iter()
        .find(|a| a.name == *file)
        .ok_or("UPDATE_COMPONENT_ASSET_MISSING")?;
    validate_asset_url(&expected_tag, &asset)?;
    download_verified_asset(&c, asset, expected_tag, expected_sha256).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_release_components_have_separate_verified_versions() {
        let tag = "v1.14.83-rc.2";
        let names = [
            "SuperAgent_1.14.83_x64-setup.exe",
            "SuperAgent_1.14.83_aarch64.dmg",
            "SuperAgent_1.14.83_amd64.deb",
            "SuperAgent_1.14.83_amd64.AppImage",
            "superagent-delegate-1.10.1.zip",
            "superagent-sidepanel-1.0.0.zip",
            "SuperAgent-LAN-Android-0.10.0-native-dashboard-debug.apk",
            "SuperAgent-LAN-Client-0.2.0-Windows-x64-setup.exe",
        ];
        let mut manifest = String::new();
        let assets: Vec<ReleaseAsset> = names
            .iter()
            .map(|filename| {
                manifest.push_str(&format!("{}  ./{}\n", "a".repeat(64), filename));
                ReleaseAsset {
                    name: (*filename).into(),
                    size: if filename.ends_with(".zip") {
                        2000
                    } else if filename.ends_with(".apk") {
                        6_000_000
                    } else {
                        30_000_000
                    },
                    browser_download_url: format!(
                        "https://github.com/RudyCity/superagent/releases/download/{tag}/{filename}"
                    ),
                }
            })
            .collect();
        let release = ReleaseRecord {
            tag_name: tag.into(),
            draft: false,
            prerelease: true,
            assets,
        };
        let items = component_catalog(&release, &manifest, "1.14.82", "1.14.83").unwrap();
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        for id in [
            "superagent",
            "chrome-delegate",
            "chrome-sidepanel",
            "android-lan",
            "windows-lan",
        ] {
            assert!(ids.contains(&id), "missing {id}");
        }
        for item in items.iter().filter(|item| item.available) {
            assert_eq!(item.sha256.as_deref(), Some("a".repeat(64).as_str()));
            assert!(item.file_name.is_some());
            assert!(!item.instructions.is_empty());
        }
        let extension = items
            .iter()
            .find(|item| item.id == "chrome-delegate")
            .unwrap();
        assert_eq!(extension.version, "1.10.1");
        assert_eq!(extension.installed_version, None);
        assert_eq!(extension.state, "installed_unknown");
        let android = items.iter().find(|item| item.id == "android-lan").unwrap();
        assert_eq!(android.version, "0.10.0-native-dashboard");
        let lan = items.iter().find(|item| item.id == "windows-lan").unwrap();
        assert_eq!(lan.version, "0.2.0");
        let core = items.iter().find(|item| item.id == "superagent").unwrap();
        assert_eq!(core.state, "update_available");
        assert_eq!(core.installed_version.as_deref(), Some("1.14.82"));
        assert_eq!(
            items
                .iter()
                .filter(|i| i.file_name == core.file_name)
                .count(),
            1
        );
    }
    #[test]
    fn rejects_multiple_versions_or_missing_component_checksum() {
        let tag = "v1.14.83-rc.2";
        let prefix = "superagent-delegate-";
        let make = |version: &str| {
            let name = format!("{prefix}{version}.zip");
            ReleaseAsset {
                name: name.clone(),
                size: 2000,
                browser_download_url: format!(
                    "https://github.com/RudyCity/superagent/releases/download/{tag}/{name}"
                ),
            }
        };
        let release = ReleaseRecord {
            tag_name: tag.into(),
            draft: false,
            prerelease: true,
            assets: vec![make("1.10.1"), make("1.9.0")],
        };
        assert_eq!(
            versioned_asset(&release, prefix, ".zip").unwrap_err(),
            "UPDATE_COMPONENT_AMBIGUOUS"
        );
        let release = ReleaseRecord {
            assets: vec![make("1.10.1")],
            ..release
        };
        assert!(component_catalog(&release, "", "1.14.82", "1.14.83").is_err());
    }
    #[test]
    fn download_component_requires_exact_known_id_and_hash() {
        assert!(valid_confirmation("v1.14.83-rc.2", &"b".repeat(64)).is_ok());
        assert!(valid_confirmation("v1.14.83-rc.2/../../", &"b".repeat(64)).is_err());
        assert!(valid_confirmation("v1.14.83-rc.2", "malformed").is_err());
    }
    #[test]
    fn release_candidate_provenance_prevents_false_same_version() {
        assert_eq!(
            release_state("1.14.83", "1.14.83", "v1.14.83-rc.3", None),
            "build_unverified"
        );
        assert_eq!(
            release_state("1.14.83", "1.14.83", "v1.14.83-rc.3", Some("v1.14.83-rc.2")),
            "update_available"
        );
        assert_eq!(
            release_state("1.14.83", "1.14.83", "v1.14.83-rc.3", Some("v1.14.83-rc.3")),
            "same_version"
        );
        assert_eq!(
            release_state("1.14.83", "1.14.83", "v1.14.83-rc.3", Some("v1.14.83-rc.4")),
            "installed_newer"
        );
        assert_eq!(
            release_state("1.14.84", "1.14.83", "v1.14.83-rc.3", None),
            "installed_newer"
        );
    }
    #[test]
    fn target_packages_are_pinned_for_each_supported_architecture() {
        assert_eq!(
            target_package("windows", "x86_64", "1.14.83").unwrap().1,
            "SuperAgent_1.14.83_x64-setup.exe"
        );
        assert_eq!(
            target_package("macos", "aarch64", "1.14.83").unwrap().1,
            "SuperAgent_1.14.83_aarch64.dmg"
        );
        assert_eq!(
            target_package("linux", "x86_64", "1.14.83").unwrap().1,
            "SuperAgent_1.14.83_amd64.AppImage"
        );
        assert!(target_package("linux", "aarch64", "1.14.83").is_none());
        assert!(target_package("windows", "x86", "1.14.83").is_none());
    }
    #[test]
    fn tampered_existing_download_is_refused() {
        let root =
            std::env::temp_dir().join(format!("superagent-update-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = root.join("update.bin");
        let data = b"verified native update payload";
        fs::write(&file, data).unwrap();
        let hash = format!("{:x}", Sha256::digest(data));
        assert!(verify_existing(&file, &hash, data.len() as u64).is_ok());
        assert!(verify_existing(&file, &"0".repeat(64), data.len() as u64).is_err());
        assert!(verify_existing(&file, &hash, (data.len() + 1) as u64).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn release_rc_orders_are_strict() {
        assert!(release_order("v1.14.83-rc.2") > release_order("v1.14.83-rc.1"));
        assert!(release_order("v1.15.0-rc.1") > release_order("v1.14.999-rc.100"));
        for invalid in [
            "main",
            "v1.14.83",
            "v1.14.83-rc.2/../../",
            "v1.14.83-rc.-1",
            "v1.14.83-rc.1a",
        ] {
            assert!(release_order(invalid).is_none());
        }
    }
    #[test]
    fn checksum_accepts_normal_and_relative_basename_only() {
        let name = "SuperAgent_1.14.83_x64-setup.exe";
        let good = "a".repeat(64);
        assert_eq!(
            sha256_for_file(&format!("{good}  ./{name}\n"), name).unwrap(),
            good
        );
        assert_eq!(
            sha256_for_file(&format!("{good} *{name}\n"), name).unwrap(),
            good
        );
        assert!(sha256_for_file(&format!("{good}  ../{name}\n"), name).is_err());
        assert!(sha256_for_file(&format!("{good}  ./{name}\n{good}  {name}\n"), name).is_err());
        assert!(sha256_for_file(&format!("{good}  ./{name}\nmalformed  {name}\n"), name).is_err());
    }
    #[test]
    fn latest_ignores_non_rc_draft_or_unpublished() {
        let make = |tag: &str, draft: bool, prerelease: bool| ReleaseRecord {
            tag_name: tag.into(),
            draft,
            prerelease,
            assets: vec![],
        };
        let all = vec![
            make("v1.14.83-rc.1", false, true),
            make("v1.14.84-rc.1", true, true),
            make("v1.14.85-rc.1", false, false),
            make("v1.14.83-rc.2", false, true),
        ];
        assert_eq!(latest(&all).unwrap().tag_name, "v1.14.83-rc.2");
    }
    #[test]
    fn disallows_asset_path_and_origin_substitution() {
        assert!(!valid_name("../setup.exe"));
        assert!(!valid_name("dir/setup.exe"));
        let asset = ReleaseAsset {
            name: "SuperAgent_1.14.83_x64-setup.exe".into(),
            size: 100_000_000,
            browser_download_url: "https://attacker.example/evil".into(),
        };
        assert!(validate_asset_url("v1.14.83-rc.2", &asset).is_err());
    }
}

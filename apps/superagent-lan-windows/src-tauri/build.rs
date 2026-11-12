use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
fn main() {
    let source = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"))
        .join("resources").join("superagent-lan-client.exe");
    println!("cargo:rerun-if-changed={}", source.display());
    let bytes = fs::read(&source).expect("Build the GUI receiver sidecar before compiling Tauri.");
    assert!((100_000..=160_000_000).contains(&bytes.len()), "Receiver sidecar outside trusted size bounds");
    println!("cargo:rustc-env=SUPERAGENT_LAN_BINARY_SHA256={:x}", Sha256::digest(&bytes));
    tauri_build::build();
}

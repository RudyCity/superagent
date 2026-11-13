use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Numeric build identifier is fixed when this particular binary is compiled.
    // SOURCE_DATE_EPOCH allows reproducible build pipelines to pin the value.
    let build_number = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .filter(|value| {
            value.len() >= 10 && value.len() <= 12 && value.bytes().all(|ch| ch.is_ascii_digit())
        })
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be after the UNIX epoch")
                .as_secs()
                .to_string()
        });
    println!("cargo:rustc-env=SUPERAGENT_TRAY_BUILD_NUMBER={build_number}");
    // Native tagged release provenance: a 1.14.83-rc.2 desktop binary is not
    // equivalent to source builds or later RCs with the same package version.
    // Only record a tag that matches Cargo's immutable package version.
    println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");
    if let Ok(tag) = std::env::var("GITHUB_REF_NAME") {
        let prefix = format!("v{}-rc.", env!("CARGO_PKG_VERSION"));
        if let Some(rc) = tag.strip_prefix(&prefix) {
            if !rc.is_empty() && rc.bytes().all(|ch| ch.is_ascii_digit()) {
                println!("cargo:rustc-env=SUPERAGENT_RELEASE_TAG={tag}");
            }
        }
    }
    tauri_build::build();
}

use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Numeric build identifier is fixed when this particular binary is compiled.
    // SOURCE_DATE_EPOCH allows reproducible build pipelines to pin the value.
    let build_number = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .filter(|value| value.len() >= 10
            && value.len() <= 12
            && value.bytes().all(|ch| ch.is_ascii_digit()))
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be after the UNIX epoch")
                .as_secs()
                .to_string()
        });
    println!("cargo:rustc-env=SUPERAGENT_TRAY_BUILD_NUMBER={build_number}");
    tauri_build::build();
}

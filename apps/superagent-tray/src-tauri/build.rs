use sha2::{Digest,Sha256};
use std::{fs,path::{Path,PathBuf}};

/// Hash exactly the static frontendDist tree embedded by Tauri, in stable order.
/// Never use Git labels or file mtimes as a WebView asset fingerprint.
fn digest_static_assets(dir:&Path)->String {
    let mut files:Vec<PathBuf>=Vec::new();
    fn collect(base:&Path,at:&Path,out:&mut Vec<PathBuf>){
        let mut names:Vec<_>=fs::read_dir(at).expect("Tray WebView directory unavailable")
            .map(|x|x.expect("Tray WebView entry unavailable")).collect();
        names.sort_by_key(|x|x.file_name());
        for item in names {
            let p=item.path();
            let md=fs::symlink_metadata(&p).expect("Tray asset metadata unavailable");
            assert!(!md.file_type().is_symlink(),"Tray asset symlink not allowed");
            if md.is_dir() {collect(base,&p,out);}
            else if md.is_file() {
                assert!(md.len()<=12*1024*1024,"Tray embedded asset too large");
                out.push(p);
            }
        }
    }
    collect(dir,dir,&mut files);
    assert!(!files.is_empty(),"No Tray WebView assets to attest");
    let mut hash=Sha256::new();
    for file in files {
        println!("cargo:rerun-if-changed={}",file.display());
        let name=file.strip_prefix(dir).unwrap().to_string_lossy().replace('\\',"/");
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(fs::read(&file).expect("Tray embedded asset unreadable"));
    }
    format!("{:x}",hash.finalize())
}

use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    println!("cargo:rustc-env=SUPERAGENT_TRAY_UI_DIGEST={}",
        digest_static_assets(Path::new("../ui")));
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    if let Ok(revision)=std::env::var("GITHUB_SHA") {
        if revision.len()==40 && revision.bytes().all(|b|b.is_ascii_hexdigit()){
            println!("cargo:rustc-env=SUPERAGENT_TRAY_SOURCE_REVISION={}",revision.to_ascii_lowercase());
        }
    }
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

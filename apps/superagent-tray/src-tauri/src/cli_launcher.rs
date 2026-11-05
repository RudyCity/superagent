use std::path::PathBuf;
use std::process::{Command, Stdio};

fn find_cli_script() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("SUPERAGENT_CLI_PATH") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            // 1. Direct sibling dist/cli.js
            let sibling_dist = exe_dir.join("dist").join("cli.js");
            if sibling_dist.exists() {
                return Some(sibling_dist);
            }
            // 2. Self-contained installer resources on Windows live under $INSTDIR/standalone.
            // Tauri externalBin installs Bun and this launcher alongside the app executable.
            let standalone_cli = exe_dir.join("standalone").join("dist").join("cli.js");
            if standalone_cli.exists() {
                return Some(standalone_cli);
            }
            // Also honor alternate resource directory layouts for portable/legacy installs.
            let resource_cli = exe_dir.join("resources").join("standalone").join("dist").join("cli.js");
            if resource_cli.exists() {
                return Some(resource_cli);
            }
            // 3. Legacy bundled resource: resources/dist/cli.js or resources/cli.js
            let res_dist = exe_dir.join("resources").join("dist").join("cli.js");
            if res_dist.exists() {
                return Some(res_dist);
            }
            let res_direct = exe_dir.join("resources").join("cli.js");
            if res_direct.exists() {
                return Some(res_direct);
            }
            // Native standalone macOS .app: Contents/MacOS -> Contents/Resources.
            let mac_standalone = exe_dir.join("..").join("Resources").join("standalone").join("dist").join("cli.js");
            if mac_standalone.exists() {
                return Some(mac_standalone);
            }
            // Native Linux .deb or AppImage: usr/bin -> usr/lib/superagent.
            for installed_name in ["superagent", "superagent-tray", "super-agent", "SuperAgent"] {
                let linux_standalone = exe_dir.join("..").join("lib").join(installed_name).join("standalone").join("dist").join("cli.js");
                if linux_standalone.exists() {
                    return Some(linux_standalone);
                }
            }
            // 3. Legacy macOS bundle: ../Resources/dist/cli.js or ../Resources/cli.js
            let mac_res_dist = exe_dir.join("..").join("Resources").join("dist").join("cli.js");
            if mac_res_dist.exists() {
                return Some(mac_res_dist);
            }
            let mac_res_direct = exe_dir.join("..").join("Resources").join("cli.js");
            if mac_res_direct.exists() {
                return Some(mac_res_direct);
            }
            // 4. Project root relative (when developing in-repo: target/debug -> project root)
            if let Some(parent) = exe_dir.parent() {
                if let Some(grandparent) = parent.parent() {
                    if let Some(root) = grandparent.parent() {
                        let root_dist = root.join("dist").join("cli.js");
                        if root_dist.exists() {
                            return Some(root_dist);
                        }
                    }
                }
            }
        }
    }

    // Check home directory global install: ~/.superagent-r/dist/cli.js
    if let Some(home) = dirs::home_dir() {
        let global_cli = home.join(".superagent-r").join("dist").join("cli.js");
        if global_cli.exists() {
            return Some(global_cli);
        }
        let bun_global = home.join(".bun").join("install").join("global")
            .join("node_modules").join("superagent").join("dist").join("cli.js");
        if bun_global.exists() {
            return Some(bun_global);
        }
    }

    // Current working directory dist/cli.js
    if let Ok(cwd) = std::env::current_dir() {
        let cwd_dist = cwd.join("dist").join("cli.js");
        if cwd_dist.exists() {
            return Some(cwd_dist);
        }
    }

    None
}

fn find_runner_binary() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("BUN_EXECUTABLE") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let adjacent_bun = exe_dir.join(if cfg!(windows) { "bun.exe" } else { "bun" });
            if adjacent_bun.exists() {
                return Some(adjacent_bun);
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        let bun_in_home = home.join(".bun").join("bin").join(if cfg!(windows) { "bun.exe" } else { "bun" });
        if bun_in_home.exists() {
            return Some(bun_in_home);
        }
    }

    // Check system PATH
    let bun_name = if cfg!(windows) { "bun.exe" } else { "bun" };
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(bun_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // Fallback: check node
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(node_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();

    let cli_path = match find_cli_script() {
        Some(p) => p,
        None => {
            eprintln!("Error: Could not locate SuperAgent Core distribution (dist/cli.js).");
            eprintln!("Please ensure SuperAgent is installed properly or set SUPERAGENT_CLI_PATH.");
            std::process::exit(1);
        }
    };

    let runner = match find_runner_binary() {
        Some(r) => r,
        None => {
            eprintln!("Error: Could not locate a JavaScript runtime (Bun or Node.js).");
            eprintln!("Please install Bun (https://bun.sh) or ensure bun is on your PATH.");
            std::process::exit(1);
        }
    };

    let mut cmd = Command::new(&runner);
    cmd.arg(&cli_path);
    for arg in args {
        cmd.arg(arg);
    }

    cmd.stdin(Stdio::inherit())
       .stdout(Stdio::inherit())
       .stderr(Stdio::inherit());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        eprintln!("Failed to execute SuperAgent process: {}", err);
        std::process::exit(1);
    }

    #[cfg(not(unix))]
    {
        match cmd.status() {
            Ok(status) => {
                let code = status.code().unwrap_or(0);
                std::process::exit(code);
            }
            Err(e) => {
                eprintln!("Failed to run SuperAgent: {}", e);
                std::process::exit(1);
            }
        }
    }
}

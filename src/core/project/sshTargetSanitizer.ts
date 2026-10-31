export interface SshSanitizeResult {
  valid: boolean;
  sanitized?: string;
  hasStrippedCredentials?: boolean;
  requiresManualProfile?: boolean;
  error?: string;
}

/**
 * Returns true if the string represents an SSH target URI or protocol prefix.
 */
export function isSshTarget(target: string): boolean {
  if (!target || typeof target !== "string") return false;
  const trimmed = target.trim();
  return trimmed.startsWith("ssh:") || trimmed.startsWith("ssh://");
}

/**
 * Sanitizes an SSH target string by:
 * 1. Validating protocol (ssh: / ssh://) and hostname.
 * 2. Stripping passwords, query parameters (e.g. ?key=..., ?password=...), and hash fragments.
 * 3. Never logging or returning the stripped secret material.
 * 4. Normalizing the path without trailing slashes.
 */
export function sanitizeSshTarget(rawTarget: string): SshSanitizeResult {
  if (!rawTarget || typeof rawTarget !== "string") {
    return { valid: false, error: "SSH target must be a non-empty string." };
  }
  const trimmed = rawTarget.trim();
  if (!isSshTarget(trimmed)) {
    return { valid: false, error: "Target is not an SSH URI." };
  }

  let normalizedForUrl = trimmed;
  if (trimmed.startsWith("ssh:") && !trimmed.startsWith("ssh://")) {
    normalizedForUrl = "ssh://" + trimmed.slice("ssh:".length);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedForUrl);
  } catch {
    return { valid: false, error: "Malformed SSH URI." };
  }

  if (parsed.protocol !== "ssh:") {
    return { valid: false, error: "Protocol must be ssh:." };
  }

  if (!parsed.hostname) {
    return { valid: false, error: "SSH target requires a valid hostname or IP address." };
  }

  let hasStrippedCredentials = false;
  if (parsed.password) {
    hasStrippedCredentials = true;
    parsed.password = "";
  }
  if (parsed.search) {
    hasStrippedCredentials = true;
    parsed.search = "";
  }
  if (parsed.hash) {
    hasStrippedCredentials = true;
    parsed.hash = "";
  }

  let pathname = parsed.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;

  const sanitized = parsed.toString().replace(/\/$/, "") || parsed.toString();

  return {
    valid: true,
    sanitized,
    hasStrippedCredentials,
    requiresManualProfile: hasStrippedCredentials,
  };
}

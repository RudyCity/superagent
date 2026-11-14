// SuperAgent Desktop Live: macOS 14+ ScreenCaptureKit exact-CGWindowID
// Per-session native helper. No desktop/display fallback, input, recording,
// temporary screenshot files, or user-selected arbitrary executable paths.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Bounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct ApprovedWindow: Codable {
    let pid: Int32
    let nativeId: String
    let title: String
    let application: String
    let bounds: Bounds
}

enum PreviewFailure: Error {
    case denied
}

func require(_ predicate: @autoclosure () -> Bool) throws {
    if !predicate() { throw PreviewFailure.denied }
}

@available(macOS 14.0, *)
struct ExactWindowSession {
    let approved: ApprovedWindow
    let windowID: CGWindowID
    let started = Date()

    init() throws {
        guard let json = ProcessInfo.processInfo.environment["SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET"],
              let data = json.data(using: .utf8), data.count > 0 && data.count < 4096
        else { throw PreviewFailure.denied }
        approved = try JSONDecoder().decode(ApprovedWindow.self, from: data)
        let text = approved.nativeId
        guard text.hasPrefix("cg:"), let number = UInt32(text.dropFirst(3)), number > 0,
              approved.pid > 0,
              !approved.title.isEmpty, approved.title.count <= 512,
              !approved.application.isEmpty, approved.application.count <= 256,
              approved.bounds.width > 0, approved.bounds.height > 0,
              approved.bounds.width <= 8192, approved.bounds.height <= 8192,
              approved.bounds.width * approved.bounds.height <= 16_000_000
        else { throw PreviewFailure.denied }
        windowID = number
    }

    private func near(_ a: CGFloat, _ b: Double) -> Bool {
        abs(Double(a) - b) <= 1.0
    }

    // Screens are never used as a fallback. Resolve precisely one matching
    // CoreGraphics window ID, PID, sharing state, on-screen visibility, title,
    // app owner and geometry. Reject absent/ambiguous/protected windows.
    func verifyCoreGraphics() throws {
        try require(CGPreflightScreenCaptureAccess())
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let entries = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
        else { throw PreviewFailure.denied }
        let matches = entries.filter {
            guard let raw = $0[kCGWindowNumber as String] as? NSNumber else { return false }
            return raw.uint32Value == windowID
        }
        try require(matches.count == 1)
        let info = matches[0]
        guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
              let title = info[kCGWindowName as String] as? String,
              let app = info[kCGWindowOwnerName as String] as? String,
              let layer = info[kCGWindowLayer as String] as? NSNumber,
              let rawBounds = info[kCGWindowBounds as String] as? CFDictionary,
              let frame = CGRect(dictionaryRepresentation: rawBounds)
        else { throw PreviewFailure.denied }
        try require(owner.int32Value == approved.pid)
        try require(title == approved.title && app == approved.application)
        try require(layer.intValue == 0)
        if let sharing = info[kCGWindowSharingState as String] as? NSNumber {
            try require(sharing.intValue != 0)
        }
        try require(near(frame.origin.x, approved.bounds.x))
        try require(near(frame.origin.y, approved.bounds.y))
        try require(near(frame.size.width, approved.bounds.width))
        try require(near(frame.size.height, approved.bounds.height))
    }

    func matchingShareableWindow() async throws -> SCWindow {
        try verifyCoreGraphics()
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        let windows = content.windows.filter { $0.windowID == windowID }
        try require(windows.count == 1)
        let window = windows[0]
        try require(window.owningApplication?.processID == approved.pid)
        try require(window.owningApplication?.applicationName == approved.application)
        try require(window.title == approved.title)
        try require(near(window.frame.origin.x, approved.bounds.x))
        try require(near(window.frame.origin.y, approved.bounds.y))
        try require(near(window.frame.size.width, approved.bounds.width))
        try require(near(window.frame.size.height, approved.bounds.height))
        return window
    }

    func captureFrame() async throws -> [String: Any] {
        try require(Date().timeIntervalSince(started) <= 300)
        let window = try await matchingShareableWindow()
        let config = SCStreamConfiguration()
        config.width = Int(approved.bounds.width.rounded())
        config.height = Int(approved.bounds.height.rounded())
        config.showsCursor = false
        config.scalesToFit = true
        try require(config.width > 0 && config.height > 0 &&
                    config.width * config.height <= 16_000_000)
        // Unlike display filters, this only captures the approved SCWindow.
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: config)
        try verifyCoreGraphics()
        try require(image.width > 0 && image.height > 0 &&
                    image.width <= 8192 && image.height <= 8192 &&
                    image.width * image.height <= 16_000_000)
        let x = Double(image.width) / approved.bounds.width
        let y = Double(image.height) / approved.bounds.height
        try require(x >= 0.9 && y >= 0.9 && x <= 3.1 && y <= 3.1 &&
                    abs(x - y) <= 0.08)
        let png = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(
            png as CFMutableData, UTType.png.identifier as CFString, 1, nil)
        else { throw PreviewFailure.denied }
        CGImageDestinationAddImage(encoder, image, nil)
        try require(CGImageDestinationFinalize(encoder))
        try require(png.length >= 24 && png.length <= 8 * 1024 * 1024)
        try verifyCoreGraphics()

        return [
            "type": "frame",
            "png": png.base64EncodedString(),
            "window": [
                "pid": approved.pid,
                "nativeId": approved.nativeId,
                "title": approved.title,
                "active": NSWorkspace.shared.frontmostApplication?.processIdentifier == approved.pid,
                "bounds": [
                    "x": approved.bounds.x,
                    "y": approved.bounds.y,
                    "width": approved.bounds.width,
                    "height": approved.bounds.height
                ]
            ]
        ]
    }
}

func emit(_ message: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed])
    guard let newline = "\n".data(using: .utf8) else { throw PreviewFailure.denied }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(newline)
}

@main struct ScreenCaptureHost {
    static func main() async {
        guard #available(macOS 14.0, *) else {
            exit(2)
        }
        do {
            let session = try ExactWindowSession()
            try session.verifyCoreGraphics()
            // Do not issue CGRequestScreenCaptureAccess here. Host native Tray
            // consent and OS Screen Recording grant are independent requirements.
            try emit(["type": "ready"])
            while let command = readLine() {
                if command == "close" { break }
                if command != "capture" { break }
                do {
                    let result = try await session.captureFrame()
                    try emit(result)
                } catch {
                    try? emit(["type": "denied"])
                    break
                }
            }
        } catch {
            // No windows, titles, permission diagnostics or images on stderr.
            exit(2)
        }
    }
}

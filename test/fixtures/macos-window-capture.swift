import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Execute the real window capture decision against the observed ScreenCaptureKit refusal.
// This fixture never captures a screen, activates a window or requests OS permission.
private typealias CGWindowID = UInt32
private struct CGImage { let width: Int; let height: Int }
private struct SCWindow { let windowID: CGWindowID; let frame: CGRect; let isOnScreen: Bool }
private struct SCShareableContent { let windows: [SCWindow] }
private struct SCContentFilter {
    let window: SCWindow
    init(desktopIndependentWindow: SCWindow) { window = desktopIndependentWindow }
}
private final class SCStreamConfiguration {
    var width = 0
    var height = 0
    var showsCursor = true
    var ignoreShadowsSingleWindow = false
}
private struct ProbeFailure: Error { let code: String }
private func fail(_ code: String, _ message: String) -> ProbeFailure { ProbeFailure(code: code) }
private var captures = 0
private var cursor: Bool?
private func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration) throws -> CGImage {
    captures += 1
    // Reproduced on macOS 27: both screenshot APIs fail -3811 for this combination.
    if !filter.window.isOnScreen && configuration.showsCursor { throw fail("CAPTURE_FAILED", "-3811") }
    guard configuration.ignoreShadowsSingleWindow else { throw fail("SHADOWS", "unsafe geometry") }
    cursor = configuration.showsCursor
    return CGImage(width: configuration.width, height: configuration.height)
}
private func resizedImage(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    CGImage(width: width, height: height)
}

// PRODUCTION_FUNCTIONS

private func verifyCapture() throws {
    let bounds = CGRect(x: 80, y: 470, width: 640, height: 432)
    for visible in [false, true] {
        let window = SCWindow(windowID: 17, frame: bounds, isOnScreen: visible)
        let (image, region) = try captureWindow(17, maxWidth: 320, content: SCShareableContent(windows: [window]), expectedGeometry: bounds)
        guard region == bounds, image.width == 320, image.height == 216, cursor == visible else {
            throw fail("WRONG_CAPTURE", "window identity, geometry or cursor changed")
        }
        print("PASS: \(visible ? "visible window retains cursor" : "off-Space window captures without foreign cursor")")
    }
    let known = SCShareableContent(windows: [SCWindow(windowID: 17, frame: bounds, isOnScreen: false)])
    for (id, geometry, code) in [(UInt32(99), bounds, "WINDOW_NOT_FOUND"), (UInt32(17), bounds.offsetBy(dx: 50, dy: 0), "STALE_FRAME")] {
        let before = captures
        do {
            _ = try captureWindow(id, maxWidth: 320, content: known, expectedGeometry: geometry)
            throw fail("UNEXPECTED_SUCCESS", code)
        } catch let failure as ProbeFailure where failure.code == code {}
        guard captures == before else { throw fail("DISPATCHED", "invalid target reached capture") }
        print("PASS: \(code) refuses before capture")
    }
    let largeBounds = CGRect(x: 0, y: 0, width: 10000, height: 30000)
    let large = SCWindow(windowID: 18, frame: largeBounds, isOnScreen: false)
    let (image, _) = try captureWindow(18, maxWidth: 2560, content: SCShareableContent(windows: [large]), expectedGeometry: largeBounds)
    guard image.width <= 2560, image.width * image.height <= maxDecodedScreenshotPixels else { throw fail("UNBOUNDED", "pixel budget exceeded") }
    print("PASS: off-Space capture retains the decoded-pixel budget")
    
}
do { try verifyCapture() }
catch {
    FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8))
    exit(1)
}

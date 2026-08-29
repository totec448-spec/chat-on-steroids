import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers

private typealias JSONObject = [String: Any]

private struct HelperFailure: Error {
    let code: String
    let message: String
}

private func fail(_ code: String, _ message: String) -> HelperFailure {
    HelperFailure(code: code, message: message)
}

private func number(_ value: Any?) -> NSNumber? {
    value as? NSNumber
}

private func int(_ value: Any?, default fallback: Int = 0) -> Int {
    number(value)?.intValue ?? fallback
}

private func bool(_ value: Any?, default fallback: Bool = false) -> Bool {
    number(value)?.boolValue ?? fallback
}

private func string(_ value: Any?, default fallback: String = "") -> String {
    value as? String ?? fallback
}

private func rectObject(_ rect: CGRect) -> JSONObject {
    [
        "x": Int(rect.origin.x.rounded()),
        "y": Int(rect.origin.y.rounded()),
        "width": Int(rect.width.rounded()),
        "height": Int(rect.height.rounded())
    ]
}

private func rect(_ value: Any?) -> CGRect? {
    guard let object = value as? JSONObject else { return nil }
    let x = number(object["x"])?.doubleValue
    let y = number(object["y"])?.doubleValue
    let width = number(object["width"])?.doubleValue
    let height = number(object["height"])?.doubleValue
    guard let x, let y, let width, let height, width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

private let maxDecodedScreenshotPixels = 8_000_000

private func approximatelyEqual(_ left: CGRect, _ right: CGRect, tolerance: CGFloat = 2) -> Bool {
    abs(left.minX - right.minX) <= tolerance &&
        abs(left.minY - right.minY) <= tolerance &&
        abs(left.maxX - right.maxX) <= tolerance &&
        abs(left.maxY - right.maxY) <= tolerance
}

private func convincinglyMatchesWindow(_ candidate: CGRect, _ expected: CGRect) -> Bool {
    guard !candidate.isNull, !candidate.isEmpty else { return false }
    let intersection = candidate.intersection(expected)
    guard !intersection.isNull, !intersection.isEmpty else { return false }
    let intersectionArea = intersection.width * intersection.height
    let unionArea = candidate.width * candidate.height + expected.width * expected.height - intersectionArea
    guard unionArea > 0, intersectionArea / unionArea >= 0.8 else { return false }
    let maximumEdgeDelta = max(
        abs(candidate.minX - expected.minX),
        abs(candidate.minY - expected.minY),
        abs(candidate.maxX - expected.maxX),
        abs(candidate.maxY - expected.maxY)
    )
    return maximumEdgeDelta <= 64
}

private func virtualScreenRect() throws -> CGRect {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        throw fail("SCREEN_UNAVAILABLE", "no active display is available")
    }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else {
        throw fail("SCREEN_UNAVAILABLE", "the active display list could not be read")
    }
    return displays.prefix(Int(count)).map(CGDisplayBounds).reduce(CGRect.null) { $0.union($1) }
}

private struct WindowRow {
    let id: CGWindowID
    let pid: pid_t
    let title: String
    let process: String
    let bounds: CGRect
    let onScreen: Bool
    let layer: Int

    func json(foreground: CGWindowID?) -> JSONObject {
        [
            "id": Int(id),
            "title": title,
            "process": process,
            "x": Int(bounds.origin.x.rounded()),
            "y": Int(bounds.origin.y.rounded()),
            "width": Int(bounds.width.rounded()),
            "height": Int(bounds.height.rounded()),
            "state": id == foreground ? "foreground" : (onScreen ? "open" : "minimized")
        ]
    }
}

private func minimizedWindowIDs(in rows: [WindowRow]) -> Set<CGWindowID> {
    // CGWindowIsOnscreen is also false for hidden apps and windows on another Space.
    // Only AXMinimized plus the exact CG window number is strong enough to label a
    // row "minimized" without flooding discovery with unrelated offscreen windows.
    guard AXIsProcessTrusted() else { return [] }
    let candidatePids = Set(rows.lazy.filter { !$0.onScreen }.map(\.pid)).prefix(64)
    var ids = Set<CGWindowID>()
    for pid in candidatePids {
        let app = AXUIElementCreateApplication(pid)
        let windows = axAttribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
        for window in windows.prefix(64) where axBool(window, kAXMinimizedAttribute as CFString, default: false) {
            if let id = axWindowNumber(window) { ids.insert(id) }
        }
    }
    return ids
}

private func allWindowRows(includeMinimized: Bool = true) -> [WindowRow] {
    guard let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [JSONObject] else { return [] }
    let ownPid = getpid()
    let rows: [WindowRow] = raw.compactMap { item -> WindowRow? in
        guard
            let id = number(item[kCGWindowNumber as String])?.uint32Value,
            let pid = number(item[kCGWindowOwnerPID as String])?.int32Value,
            pid != ownPid,
            let boundsDictionary = item[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
            bounds.width > 1,
            bounds.height > 1
        else { return nil }
        let layer = int(item[kCGWindowLayer as String])
        let onScreen = bool(item[kCGWindowIsOnscreen as String])
        let alpha = number(item[kCGWindowAlpha as String])?.doubleValue ?? 1
        guard layer == 0, alpha > 0 else { return nil }
        let process = string(item[kCGWindowOwnerName as String], default: "Process \(pid)")
        let title = string(item[kCGWindowName as String]).trimmingCharacters(in: .whitespacesAndNewlines)
        let displayTitle = title.isEmpty ? "\(process) window" : title
        return WindowRow(
            id: id,
            pid: pid,
            title: displayTitle,
            process: process,
            bounds: bounds,
            onScreen: onScreen,
            layer: layer
        )
    }
    let visible = rows.filter { $0.onScreen }
    guard includeMinimized else { return visible }
    let minimized = minimizedWindowIDs(in: rows)
    return rows.filter { $0.onScreen || minimized.contains($0.id) }
}

private func windowRow(_ id: CGWindowID) -> WindowRow? {
    allWindowRows().first { $0.id == id }
}

private func foregroundWindowID() -> CGWindowID? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return allWindowRows(includeMinimized: false).first { $0.pid == app.processIdentifier }?.id
}

private func requireAccessibility(prompt: Bool) throws {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options) else {
        throw fail(
            "ACCESSIBILITY_PERMISSION_REQUIRED",
            "enable Accessibility for Chat On Steroids in System Settings > Privacy & Security > Accessibility, then retry"
        )
    }
}

private func requireScreenCapture() throws {
    guard CGPreflightScreenCaptureAccess() else {
        _ = CGRequestScreenCaptureAccess()
        throw fail(
            "SCREEN_PERMISSION_REQUIRED",
            "enable Screen Recording for Chat On Steroids in System Settings > Privacy & Security > Screen & System Audio Recording, then retry"
        )
    }
}

private func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axAttribute(element, attribute) as? String
}

private func axBool(_ element: AXUIElement, _ attribute: CFString, default fallback: Bool) -> Bool {
    (axAttribute(element, attribute) as? NSNumber)?.boolValue ?? fallback
}

private func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let value = axAttribute(element, attribute) else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let value = axAttribute(element, attribute) else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

private func axBounds(_ element: AXUIElement) -> CGRect? {
    guard let point = axPoint(element, kAXPositionAttribute as CFString),
          let size = axSize(element, kAXSizeAttribute as CFString),
          size.width >= 0,
          size.height >= 0 else { return nil }
    return CGRect(origin: point, size: size)
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func axRole(_ element: AXUIElement) -> String {
    let raw = axString(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
}

private func axName(_ element: AXUIElement) -> String {
    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        if let value = axString(element, attribute as CFString)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty { return value }
    }
    return ""
}

private func axWindowNumber(_ element: AXUIElement) -> CGWindowID? {
    (axAttribute(element, "AXWindowNumber" as CFString) as? NSNumber)?.uint32Value
}

private func matchingAXWindow(_ row: WindowRow, prompt: Bool = true) throws -> AXUIElement {
    try requireAccessibility(prompt: prompt)
    let app = AXUIElementCreateApplication(row.pid)
    let windows = axAttribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
    if let exact = windows.first(where: { axWindowNumber($0) == row.id }) { return exact }
    let geometryCandidates = windows.compactMap { window -> (element: AXUIElement, distance: CGFloat)? in
        guard let bounds = axBounds(window), convincinglyMatchesWindow(bounds, row.bounds) else { return nil }
        let distance = abs(bounds.minX - row.bounds.minX) + abs(bounds.minY - row.bounds.minY) +
            abs(bounds.width - row.bounds.width) + abs(bounds.height - row.bounds.height)
        return (window, distance)
    }.sorted { $0.distance < $1.distance }
    guard let winner = geometryCandidates.first else {
        throw fail("UIA_FAILED", "no accessibility window convincingly matches window \(row.id)")
    }
    if geometryCandidates.count > 1, geometryCandidates[1].distance - winner.distance < 32 {
        throw fail("UIA_FAILED", "multiple accessibility windows ambiguously match window \(row.id)")
    }
    return winner.element
}

private func focusWindow(_ id: CGWindowID) throws -> Bool {
    guard let row = windowRow(id) else { return false }
    try requireAccessibility(prompt: true)
    guard let app = NSRunningApplication(processIdentifier: row.pid) else { return false }
    let window = try matchingAXWindow(row)
    var minimizedSettable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(window, kAXMinimizedAttribute as CFString, &minimizedSettable) == .success,
       minimizedSettable.boolValue {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    _ = app.activate(options: [.activateIgnoringOtherApps])
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    for _ in 0..<50 {
        if foregroundWindowID() == id { return true }
        usleep(20_000)
    }
    return false
}

private final class UISnapshot {
    let window: CGWindowID
    let elements: [String: AXUIElement]

    init(window: CGWindowID, elements: [String: AXUIElement]) {
        self.window = window
        self.elements = elements
    }
}

private var nextSnapshotID = 1
private var snapshots: [Int: UISnapshot] = [:]
private var snapshotOrder: [Int] = []

private func rememberSnapshot(window: CGWindowID, elements: [String: AXUIElement]) -> Int {
    let id = nextSnapshotID
    nextSnapshotID += 1
    snapshots[id] = UISnapshot(window: window, elements: elements)
    snapshotOrder.append(id)
    while snapshotOrder.count > 16 {
        let removed = snapshotOrder.removeFirst()
        snapshots.removeValue(forKey: removed)
    }
    return id
}

private func findUI(
    _ request: JSONObject,
    suppliedWindow: WindowRow? = nil,
    promptForAccessibility: Bool = true
) throws -> JSONObject {
    let row: WindowRow
    if let suppliedWindow {
        row = suppliedWindow
    } else if let requested = number(request["id"])?.uint32Value, let found = windowRow(requested) {
        row = found
    } else if let foreground = foregroundWindowID(), let found = windowRow(foreground) {
        row = found
    } else {
        throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")
    }
    let root = try matchingAXWindow(row, prompt: promptForAccessibility)
    let query = string(request["query"]).lowercased()
    let roleFilter = string(request["role"]).lowercased()
    let maxResults = min(100, max(1, int(request["maxResults"], default: 30)))
    let maxVisited = min(10_000, max(maxResults, int(request["maxVisited"], default: 4_000)))
    let screen = try virtualScreenRect()

    var queue: [AXUIElement] = [root]
    var cursor = 0
    var visited = 0
    var returned: [JSONObject] = []
    var retained: [String: AXUIElement] = [:]

    while cursor < queue.count && visited < maxVisited && returned.count < maxResults {
        let element = queue[cursor]
        cursor += 1
        visited += 1
        queue.append(contentsOf: axChildren(element))

        let role = axRole(element)
        let name = axName(element)
        let identifier = axString(element, kAXIdentifierAttribute as CFString) ?? ""
        let haystack = "\(name) \(role) \(identifier)".lowercased()
        guard (query.isEmpty || haystack.contains(query)),
              (roleFilter.isEmpty || role.lowercased().contains(roleFilter)) else { continue }
        guard let bounds = axBounds(element), bounds.width >= 0, bounds.height >= 0 else { continue }
        let runtimeKey = "e\(visited)"
        retained[runtimeKey] = element
        returned.append([
            "runtimeKey": runtimeKey,
            "name": name,
            "role": role,
            "automationId": identifier,
            "enabled": axBool(element, kAXEnabledAttribute as CFString, default: true),
            "offscreen": bounds.isEmpty || !screen.intersects(bounds),
            "bounds": rectObject(bounds)
        ])
    }

    let snapshotID = rememberSnapshot(window: row.id, elements: retained)
    return [
        "window": Int(row.id),
        "snapshotId": snapshotID,
        "elements": returned,
        "visited": visited,
        "truncated": cursor < queue.count || visited >= maxVisited
    ]
}

private func mouseButton(_ name: String) -> CGMouseButton {
    switch name.lowercased() {
    case "right": return .right
    case "middle", "wheel": return .center
    default: return .left
    }
}

private func mouseTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    switch button {
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

private func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw fail("INPUT_FAILED", "could not create a mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

private func movePointer(_ point: CGPoint) throws {
    try postMouse(.mouseMoved, point: point, button: .left)
}

private func click(_ point: CGPoint, button: CGMouseButton, count: Int) throws {
    let (down, up, _) = mouseTypes(button)
    for clickIndex in 1...count {
        try postMouse(down, point: point, button: button, clickState: Int64(clickIndex))
        try postMouse(up, point: point, button: button, clickState: Int64(clickIndex))
        usleep(35_000)
    }
}

private func drag(_ xs: [NSNumber], _ ys: [NSNumber], button: CGMouseButton) throws {
    guard xs.count == ys.count, xs.count >= 2 else { throw fail("BAD_ACTION", "drag needs at least two points") }
    let points = zip(xs, ys).map { CGPoint(x: $0.0.doubleValue, y: $0.1.doubleValue) }
    let (down, up, dragged) = mouseTypes(button)
    try postMouse(down, point: points[0], button: button)
    for point in points.dropFirst() {
        try postMouse(dragged, point: point, button: button)
        usleep(12_000)
    }
    try postMouse(up, point: points[points.count - 1], button: button)
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
    "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "command": 55, "cmd": 55, "meta": 55, "shift": 56, "capslock": 57, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59, "rightshift": 60, "rightoption": 61, "rightcontrol": 62,
    "f17": 64, "volumeup": 72, "volumedown": 73, "mute": 74, "f18": 79, "f19": 80,
    "f20": 90, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
    "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
    "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117, "f4": 118, "end": 119,
    "f2": 120, "pagedown": 121, "f1": 122, "left": 123, "right": 124, "down": 125, "up": 126
]

private func pressKeys(_ names: [String]) throws {
    let codes = try names.map { name -> CGKeyCode in
        guard let code = keyCodes[name.lowercased()] else { throw fail("BAD_KEY", "unknown key \(name)") }
        return code
    }
    for code in codes {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else {
            throw fail("INPUT_FAILED", "could not create a key-down event")
        }
        event.post(tap: .cghidEventTap)
    }
    usleep(35_000)
    for code in codes.reversed() {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw fail("INPUT_FAILED", "could not create a key-up event")
        }
        event.post(tap: .cghidEventTap)
    }
}

private func typeText(_ text: String) throws {
    let units = Array(text.utf16)
    var cursor = 0
    while cursor < units.count {
        let end = min(units.count, cursor + 32)
        let chunk = Array(units[cursor..<end])
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw fail("INPUT_FAILED", "could not create a text input event")
        }
        chunk.withUnsafeBufferPointer { pointer in
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        cursor = end
    }
}

private func cursorObject() -> JSONObject {
    let location = CGEvent(source: nil)?.location ?? .zero
    return ["x": Int(location.x.rounded()), "y": Int(location.y.rounded())]
}

private func actUI(_ request: JSONObject) throws -> JSONObject {
    try requireAccessibility(prompt: true)
    let snapshotID = int(request["snapshotId"])
    let runtimeKey = string(request["runtimeKey"])
    guard let snapshot = snapshots[snapshotID], snapshot.window == number(request["id"])?.uint32Value else {
        throw fail("STALE_UI_SNAPSHOT", "the UI snapshot is no longer available")
    }
    guard let element = snapshot.elements[runtimeKey] else {
        throw fail("UNKNOWN_UI_REF", "the UI element no longer exists in snapshot \(snapshotID)")
    }
    let action = string(request["action"])
    var route = "uia"
    if action == "set_value" {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue,
              AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, string(request["value"]) as CFTypeRef) == .success else {
            throw fail("UI_ACTION_FAILED", "the control does not expose a settable value")
        }
    } else if action == "click" {
        if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
            guard try focusWindow(snapshot.window) else {
                throw fail("FOCUS_FAILED", "snapshot window \(snapshot.window) could not be activated")
            }
            guard let bounds = axBounds(element), !bounds.isEmpty else {
                throw fail("UI_ACTION_FAILED", "the control exposes neither AXPress nor usable bounds")
            }
            guard let row = windowRow(snapshot.window),
                  row.onScreen,
                  row.bounds.insetBy(dx: -24, dy: -24).contains(CGPoint(x: bounds.midX, y: bounds.midY)) else {
                throw fail("STALE_UI_SNAPSHOT", "the control is no longer inside snapshot window \(snapshot.window)")
            }
            try click(CGPoint(x: bounds.midX, y: bounds.midY), button: .left, count: 1)
            route = "sendinput"
        }
    } else {
        throw fail("BAD_ACTION", "unknown UI action \(action)")
    }
    return ["runtimeKey": runtimeKey, "name": axName(element), "route": route]
}

private func validateFrame(_ frame: JSONObject) throws {
    guard let region = rect(frame["region"]) else { throw fail("STALE_FRAME", "the coordinate frame is malformed") }
    if let windowID = number(frame["window"])?.uint32Value {
        guard let row = windowRow(windowID), row.onScreen else {
            throw fail("STALE_FRAME", "target window \(windowID) is no longer drawable")
        }
        let expected = rect(frame["windowGeometry"]) ?? region
        guard row.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) moved or resized after the screenshot")
        }
        guard try focusWindow(windowID) else { throw fail("FOCUS_FAILED", "window \(windowID) could not be activated") }
        guard let after = windowRow(windowID), after.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) changed geometry while it was activated")
        }
    } else {
        let screen = try virtualScreenRect()
        guard screen.contains(region) else { throw fail("STALE_FRAME", "desktop geometry changed after the screenshot") }
    }
}

private func shareableContent() throws -> SCShareableContent {
    let semaphore = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var failure: Error?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { value, error in
        content = value
        failure = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 12) == .success else {
        throw fail("CAPTURE_TIMEOUT", "ScreenCaptureKit did not enumerate shareable content in time")
    }
    if let failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
    guard let content else { throw fail("CAPTURE_FAILED", "ScreenCaptureKit returned no shareable content") }
    return content
}

private final class StreamFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let semaphore = DispatchSemaphore(value: 0)
    let context = CIContext(options: nil)
    var image: CGImage?
    var failure: Error?
    private var finished = false

    private func finish() {
        guard !finished else { return }
        finished = true
        semaphore.signal()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        failure = error
        finish()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid, let pixelBuffer = sampleBuffer.imageBuffer else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        image = context.createCGImage(ciImage, from: ciImage.extent)
        finish()
    }
}

private func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration) throws -> CGImage {
    if #available(macOS 14.0, *) {
        let semaphore = DispatchSemaphore(value: 0)
        var image: CGImage?
        var failure: Error?
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { value, error in
            image = value
            failure = error
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + 15) == .success else {
            throw fail("CAPTURE_TIMEOUT", "the screenshot did not finish in time")
        }
        if let failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
        guard let image else { throw fail("CAPTURE_FAILED", "ScreenCaptureKit returned no image") }
        return image
    }

    let output = StreamFrameOutput()
    let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
    do {
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "chat-on-steroids.capture"))
    } catch {
        throw fail("CAPTURE_FAILED", error.localizedDescription)
    }
    let started = DispatchSemaphore(value: 0)
    var startFailure: Error?
    stream.startCapture { error in
        startFailure = error
        started.signal()
    }
    guard started.wait(timeout: .now() + 10) == .success, startFailure == nil else {
        throw fail("CAPTURE_FAILED", startFailure?.localizedDescription ?? "the capture stream did not start")
    }
    guard output.semaphore.wait(timeout: .now() + 15) == .success else {
        stream.stopCapture(completionHandler: nil)
        throw fail("CAPTURE_TIMEOUT", "the capture stream produced no frame")
    }
    stream.stopCapture(completionHandler: nil)
    if let failure = output.failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
    guard let image = output.image else { throw fail("CAPTURE_FAILED", "the capture stream produced no image") }
    return image
}

private func writePNG(_ image: CGImage, path: String) throws {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        throw fail("CAPTURE_FAILED", "the PNG destination could not be created")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw fail("CAPTURE_FAILED", "the PNG file could not be written")
    }
}

private func scaledDimensions(region: CGRect, maxWidth: Int, nativeWidth: Int? = nil) -> (Int, Int) {
    let ceiling = max(1, maxWidth)
    let available = max(1, nativeWidth ?? Int((region.width * 2).rounded()))
    var width = min(ceiling, available)
    var height = max(1, Int((Double(width) * region.height / region.width).rounded()))
    let pixels = Double(width) * Double(height)
    if pixels > Double(maxDecodedScreenshotPixels) {
        let reduction = sqrt(Double(maxDecodedScreenshotPixels) / pixels)
        width = max(1, Int((Double(width) * reduction).rounded(.down)))
        height = max(1, Int((Double(height) * reduction).rounded(.down)))
    }
    return (width, height)
}

private func resizedImage(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    if image.width == width && image.height == height { return image }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw fail("CAPTURE_FAILED", "the scaled screenshot buffer could not be created") }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage() else { throw fail("CAPTURE_FAILED", "the screenshot could not be scaled") }
    return scaled
}

private func captureWindow(
    _ windowID: CGWindowID,
    maxWidth: Int,
    content: SCShareableContent,
    expectedGeometry: CGRect
) throws -> (CGImage, CGRect) {
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw fail("WINDOW_NOT_FOUND", "no window with id \(windowID) is available for capture")
    }
    let region = window.frame
    guard approximatelyEqual(region, expectedGeometry) else {
        throw fail("STALE_FRAME", "window \(windowID) changed geometry before capture")
    }
    let (width, height) = scaledDimensions(region: region, maxWidth: maxWidth)
    let configuration = SCStreamConfiguration()
    // The current SDK marks these setters macOS 13+. On 12.3-12.6 the stream
    // captures at its native dimensions and we resize the returned frame below.
    if #available(macOS 13.0, *) {
        configuration.width = width
        configuration.height = height
    }
    configuration.showsCursor = true
    if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let image = try captureImage(filter: filter, configuration: configuration)
    return (try resizedImage(image, width: width, height: height), region)
}

private func captureDisplay(_ display: SCDisplay, maxWidth: Int) throws -> (CGImage, CGRect) {
    let region = display.frame
    let (width, height) = scaledDimensions(region: region, maxWidth: maxWidth, nativeWidth: display.width)
    let configuration = SCStreamConfiguration()
    if #available(macOS 13.0, *) {
        configuration.width = width
        configuration.height = height
    }
    configuration.showsCursor = true
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let image = try captureImage(filter: filter, configuration: configuration)
    return (try resizedImage(image, width: width, height: height), region)
}

private func captureComposite(region target: CGRect, maxWidth: Int, displays: [SCDisplay]) throws -> CGImage {
    let (outputWidth, outputHeight) = scaledDimensions(region: target, maxWidth: maxWidth)
    let scale = CGFloat(outputWidth) / target.width
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: outputWidth,
        height: outputHeight,
        bitsPerComponent: 8,
        bytesPerRow: outputWidth * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw fail("CAPTURE_FAILED", "the composite screenshot buffer could not be created") }
    context.setFillColor(NSColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))

    for display in displays where display.frame.intersects(target) {
        let (image, displayRegion) = try captureDisplay(display, maxWidth: display.width)
        let intersection = displayRegion.intersection(target)
        guard !intersection.isNull, !intersection.isEmpty else { continue }
        let imageScaleX = CGFloat(image.width) / displayRegion.width
        let imageScaleY = CGFloat(image.height) / displayRegion.height
        let source = CGRect(
            x: (intersection.minX - displayRegion.minX) * imageScaleX,
            y: (intersection.minY - displayRegion.minY) * imageScaleY,
            width: intersection.width * imageScaleX,
            height: intersection.height * imageScaleY
        ).integral
        guard let cropped = image.cropping(to: source) else { continue }
        let destination = CGRect(
            x: (intersection.minX - target.minX) * scale,
            y: CGFloat(outputHeight) - ((intersection.minY - target.minY + intersection.height) * scale),
            width: intersection.width * scale,
            height: intersection.height * scale
        )
        context.draw(cropped, in: destination)
    }
    guard let image = context.makeImage() else { throw fail("CAPTURE_FAILED", "the composite screenshot was empty") }
    return image
}

private func capture(_ request: JSONObject, forcedWindow: CGWindowID? = nil) throws -> JSONObject {
    try requireScreenCapture()
    let file = string(request["file"])
    guard !file.isEmpty else { throw fail("BAD_REQUEST", "capture needs an output file") }
    let maxWidth = min(2_560, max(1, int(request["maxWidth"], default: 1_280)))
    let screen = try virtualScreenRect()
    let content = try shareableContent()
    let requestedWindow = forcedWindow ?? number(request["id"])?.uint32Value

    let image: CGImage
    let region: CGRect
    let captureMode: String
    var capturedWindowGeometry: CGRect?
    if let requestedWindow {
        guard let row = windowRow(requestedWindow) else {
            throw fail("WINDOW_NOT_FOUND", "no window with id \(requestedWindow) is available")
        }
        capturedWindowGeometry = row.bounds
        do {
            (image, region) = try captureWindow(
                requestedWindow,
                maxWidth: maxWidth,
                content: content,
                expectedGeometry: row.bounds
            )
            captureMode = "window"
        } catch let error as HelperFailure {
            let canUseVisibleFallback = row.onScreen && ["WINDOW_NOT_FOUND", "CAPTURE_FAILED", "CAPTURE_TIMEOUT"].contains(error.code)
            guard canUseVisibleFallback else { throw error }
            region = row.bounds
            image = try captureComposite(region: region, maxWidth: maxWidth, displays: content.displays)
            captureMode = "screen_fallback"
        }
        guard let fresh = windowRow(requestedWindow), approximatelyEqual(fresh.bounds, row.bounds) else {
            throw fail("STALE_FRAME", "window \(requestedWindow) moved or resized while it was captured")
        }
    } else if let requestedRegion = rect(request["region"]) {
        region = requestedRegion
        image = try captureComposite(region: region, maxWidth: maxWidth, displays: content.displays)
        captureMode = "screen"
    } else if bool(request["full"]) {
        region = screen
        image = try captureComposite(region: region, maxWidth: maxWidth, displays: content.displays)
        captureMode = "screen"
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw fail("SCREEN_UNAVAILABLE", "ScreenCaptureKit reported no display")
        }
        (image, region) = try captureDisplay(display, maxWidth: maxWidth)
        captureMode = "screen"
    }
    try writePNG(image, path: file)
    var response: JSONObject = [
        "region": rectObject(region),
        "image": ["width": image.width, "height": image.height],
        "screen": rectObject(screen),
        "focused": requestedWindow == nil ? NSNull() : foregroundWindowID() == requestedWindow,
        "captureMode": captureMode
    ]
    if let capturedWindowGeometry {
        response["windowGeometry"] = rectObject(capturedWindowGeometry)
    }
    return response
}

private func handle(_ request: JSONObject) throws -> JSONObject {
    let operation = string(request["op"])
    var result: JSONObject = ["ok": true]
    switch operation {
    case "warm":
        result["ready"] = true
        result["screenPermission"] = CGPreflightScreenCaptureAccess()
        result["accessibilityPermission"] = AXIsProcessTrusted()
    case "cursor":
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
    case "windows":
        let foreground = foregroundWindowID()
        result["windows"] = allWindowRows().map { $0.json(foreground: foreground) }
        result["screen"] = rectObject(try virtualScreenRect())
    case "active":
        let foreground = foregroundWindowID()
        result["window"] = foreground.flatMap(windowRow)?.json(foreground: foreground) ?? NSNull()
        result["screen"] = rectObject(try virtualScreenRect())
    case "focus":
        let id = CGWindowID(int(request["id"]))
        result["focused"] = try focusWindow(id)
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
    case "find_ui":
        result.merge(try findUI(request)) { _, new in new }
    case "act_ui":
        result.merge(try actUI(request)) { _, new in new }
    case "capture":
        result.merge(try capture(request)) { _, new in new }
    case "snapshot":
        let id = number(request["id"])?.uint32Value ?? foregroundWindowID()
        guard let id, let row = windowRow(id) else {
            throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")
        }
        result["window"] = row.json(foreground: foregroundWindowID())
        if bool(request["includeScreenshot"]) {
            result.merge(try capture(request, forcedWindow: id)) { _, new in new }
        }
        if bool(request["includeUi"]) {
            do {
                let ui = try findUI(request, suppliedWindow: row, promptForAccessibility: false)
                for key in ["snapshotId", "elements", "visited", "truncated"] {
                    result[key] = ui[key]
                }
            } catch let error as HelperFailure where error.code == "ACCESSIBILITY_PERMISSION_REQUIRED" {
                result["uiUnavailable"] = ["code": error.code, "message": error.message]
            }
        }
    case "act":
        try requireAccessibility(prompt: true)
        if let frame = request["frame"] as? JSONObject { try validateFrame(frame) }
        let actions = request["actions"] as? [JSONObject] ?? []
        var routes: [String] = []
        var completed = 0
        for (index, action) in actions.enumerated() {
            do {
                let type = string(action["type"])
                switch type {
                case "click_ui", "set_value_ui":
                    var uiRequest = action
                    uiRequest["id"] = action["window"]
                    uiRequest["action"] = type == "click_ui" ? "click" : "set_value"
                    uiRequest["value"] = action["value"]
                    let reply = try actUI(uiRequest)
                    routes.append(string(reply["route"], default: "uia"))
                case "move":
                    try movePointer(CGPoint(x: int(action["x"]), y: int(action["y"])))
                    routes.append("sendinput")
                case "click", "double_click":
                    try click(
                        CGPoint(x: int(action["x"]), y: int(action["y"])),
                        button: mouseButton(string(action["button"])),
                        count: type == "double_click" ? 2 : 1
                    )
                    routes.append("sendinput")
                case "scroll":
                    try movePointer(CGPoint(x: int(action["x"]), y: int(action["y"])))
                    guard let event = CGEvent(
                        scrollWheelEvent2Source: nil,
                        units: .line,
                        wheelCount: 2,
                        wheel1: Int32(-int(action["scroll_y"])),
                        wheel2: Int32(int(action["scroll_x"])),
                        wheel3: 0
                    ) else { throw fail("INPUT_FAILED", "could not create a scroll event") }
                    event.post(tap: .cghidEventTap)
                    routes.append("sendinput")
                case "drag":
                    try drag(
                        action["xs"] as? [NSNumber] ?? [],
                        action["ys"] as? [NSNumber] ?? [],
                        button: mouseButton(string(action["button"]))
                    )
                    routes.append("sendinput")
                case "type":
                    try typeText(string(action["text"]))
                    routes.append("sendinput")
                case "keypress":
                    try pressKeys(action["keys"] as? [String] ?? [])
                    routes.append("sendinput")
                case "focus":
                    guard try focusWindow(CGWindowID(int(action["window"]))) else {
                        throw fail("FOCUS_FAILED", "the requested window could not be activated")
                    }
                    routes.append("focus")
                default:
                    throw fail("BAD_ACTION", "unknown action \(type)")
                }
                completed += 1
            } catch let error as HelperFailure {
                return [
                    "ok": false,
                    "error_code": error.code,
                    "message": error.message,
                    "completed_count": completed,
                    "failed_index": index,
                    "routes": routes
                ]
            }
        }
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
        result["completed_count"] = completed
        result["routes"] = routes
    default:
        throw fail("BAD_REQUEST", "unknown operation \(operation)")
    }
    return result
}

private func response(for line: String) -> JSONObject {
    do {
        guard let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? JSONObject else {
            throw fail("BAD_REQUEST", "request is not a JSON object")
        }
        return try handle(request)
    } catch let error as HelperFailure {
        return ["ok": false, "error_code": error.code, "message": error.message]
    } catch {
        return ["ok": false, "error_code": "HELPER_ERROR", "message": error.localizedDescription]
    }
}

private func writeResponse(_ response: JSONObject) {
    do {
        let data = try JSONSerialization.data(withJSONObject: response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        let fallback = "{\"ok\":false,\"error_code\":\"HELPER_ERROR\",\"message\":\"response serialization failed\"}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

@main
private enum MacOSDesktopHelperMain {
    static func main() {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            autoreleasepool {
                writeResponse(response(for: line))
            }
        }
    }
}

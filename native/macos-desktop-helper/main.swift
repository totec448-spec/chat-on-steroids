import Foundation
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ScreenCaptureKit
import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import Darwin

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
private let maxEncodedScreenshotBytes = 6_242_304
private let maxAXStringCharacters = 4_096
private let maxAXTraversalSeconds = 6.0

// The addon executes synchronously inside the Electron process. A Node Worker timeout cannot
// pre-empt a blocked native accessibility message, so bound the AX transport itself and let
// longer traversals enforce their own aggregate deadline between messages.
private let axMessagingTimeoutConfigured: Void = {
    let system = AXUIElementCreateSystemWide()
    _ = AXUIElementSetMessagingTimeout(system, 1.0)
}()

private func axApplication(_ pid: pid_t) -> AXUIElement {
    _ = axMessagingTimeoutConfigured
    return AXUIElementCreateApplication(pid)
}

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

private func windowGeometryDistance(_ candidate: CGRect, _ expected: CGRect) -> CGFloat {
    abs(candidate.minX - expected.minX) + abs(candidate.minY - expected.minY) +
        abs(candidate.width - expected.width) + abs(candidate.height - expected.height)
}

private func boundedAXString(_ value: String) -> String {
    let prefix = value.prefix(maxAXStringCharacters)
    guard prefix.endIndex != value.endIndex else { return value }
    return String(prefix.dropLast()) + "…"
}

private func activeDisplayRects() throws -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        throw fail("SCREEN_UNAVAILABLE", "no active display is available")
    }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else {
        throw fail("SCREEN_UNAVAILABLE", "the active display list could not be read")
    }
    return displays.prefix(Int(count)).map(CGDisplayBounds)
}

private func orderedDisplayRects(_ rects: [CGRect]) -> [CGRect] {
    rects.map(\.integral).sorted {
        ($0.minX, $0.minY, $0.width, $0.height) < ($1.minX, $1.minY, $1.width, $1.height)
    }
}

private func displayTopologyObject(_ rects: [CGRect]) -> [JSONObject] {
    orderedDisplayRects(rects).map(rectObject)
}

private func displayTopology(_ value: Any?) -> [CGRect]? {
    guard let raw = value as? [Any] else { return nil }
    let parsed = raw.compactMap(rect)
    return parsed.count == raw.count && !parsed.isEmpty ? orderedDisplayRects(parsed) : nil
}

private func sameDisplayTopology(_ left: [CGRect], _ right: [CGRect]) -> Bool {
    orderedDisplayRects(left) == orderedDisplayRects(right)
}

private func virtualScreenRect() throws -> CGRect {
    try activeDisplayRects().reduce(CGRect.null) { $0.union($1) }
}

private func requirePointOnActiveDisplay(_ point: CGPoint, displays suppliedDisplays: [CGRect]? = nil) throws {
    let displays = try suppliedDisplays ?? activeDisplayRects()
    guard displays.contains(where: { $0.contains(point) }) else {
        throw fail(
            "OUTSIDE_ACTIVE_DISPLAY",
            "point \(Int(point.x.rounded())),\(Int(point.y.rounded())) falls outside every active display; no input was sent"
        )
    }
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
    let deadline = ProcessInfo.processInfo.systemUptime + 2.0
    pidLoop: for pid in candidatePids {
        if ProcessInfo.processInfo.systemUptime >= deadline { break }
        let app = axApplication(pid)
        let windows = axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)
        for window in windows where axBool(window, kAXMinimizedAttribute as CFString, default: false) {
            if ProcessInfo.processInfo.systemUptime >= deadline { break pidLoop }
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

private func frontmostPID() -> pid_t? {
    NSWorkspace.shared.frontmostApplication?.processIdentifier
}

private func windowServerFrontWindowID(rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    let rows = suppliedRows ?? allWindowRows(includeMinimized: false)
    let eligible = Set(rows.lazy.filter(\.onScreen).map(\.id))
    guard let ordered = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [JSONObject] else { return nil }
    // CGWindowListCopyWindowInfo documents the on-screen list in front-to-back order.
    // allWindowRows uses optionAll so it can also recover genuinely minimised windows; its
    // filtered array must not be reused as z-order evidence. Intersect the authoritative
    // ordered list with rows that already passed our layer/alpha/geometry policy instead.
    for item in ordered {
        guard let id = number(item[kCGWindowNumber as String])?.uint32Value,
              eligible.contains(id) else { continue }
        return id
    }
    return nil
}

private func foregroundWindowID() -> CGWindowID? {
    guard let pid = frontmostPID() else { return nil }
    let rows = allWindowRows(includeMinimized: false)
    guard let frontID = windowServerFrontWindowID(rows: rows),
          let front = rows.first(where: { $0.id == frontID }),
          front.pid == pid else { return nil }
    // Screen-only observation must still work without Accessibility. When AX is available,
    // disagreement means an app transition is in flight, so expose no active window rather
    // than attributing input or pixels to stale state from either subsystem.
    if AXIsProcessTrusted(), let focused = focusedAXWindowID(for: pid, rows: rows), focused != front.id {
        return nil
    }
    return front.id
}

private func requireAccessibility() throws {
    _ = axMessagingTimeoutConfigured
    // Packaged builds execute this Swift code inside the Electron process on a Node Worker.
    // Electron owns prompting through systemPreferences; native execution only performs this
    // fail-closed mutation-boundary preflight. The standalone CLI is a development probe.
    guard AXIsProcessTrusted() else {
        throw fail(
            "ACCESSIBILITY_PERMISSION_REQUIRED",
            "enable Accessibility for Chat On Steroids (Device Control on newer macOS), then fully quit and reopen the app"
        )
    }
}

private func requireScreenCapture() throws {
    guard CGPreflightScreenCaptureAccess() else {
        _ = CGRequestScreenCaptureAccess()
        throw fail(
            "SCREEN_PERMISSION_REQUIRED",
            "enable Screen Recording for Chat On Steroids, then fully quit and reopen the app"
        )
    }
}

private func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func axElementAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let value else { return nil }
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axAttribute(element, attribute) as? String
}

private func axBool(_ element: AXUIElement, _ attribute: CFString, default fallback: Bool) -> Bool {
    (axAttribute(element, attribute) as? NSNumber)?.boolValue ?? fallback
}

private func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let value = axAttribute(element, attribute) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let value = axAttribute(element, attribute) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
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

private func axElementValues(_ element: AXUIElement, attribute: CFString, limit: Int) -> [AXUIElement] {
    guard limit > 0 else { return [] }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(
        element,
        attribute,
        0,
        limit,
        &values
    ) == .success else { return [] }
    return values as? [AXUIElement] ?? []
}

private func axChildren(_ element: AXUIElement, limit: Int) -> [AXUIElement] {
    axElementValues(element, attribute: kAXChildrenAttribute as CFString, limit: limit)
}

private func axRole(_ element: AXUIElement) -> String {
    let raw = axString(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
}

private func axName(_ element: AXUIElement) -> String {
    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        if let value = axString(element, attribute as CFString)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty { return boundedAXString(value) }
    }
    return ""
}

private func axWindowNumber(_ element: AXUIElement) -> CGWindowID? {
    (axAttribute(element, "AXWindowNumber" as CFString) as? NSNumber)?.uint32Value
}

private func axPID(_ element: AXUIElement) -> pid_t? {
    var pid = pid_t()
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

private func unambiguousWindowID(bounds: CGRect, pid: pid_t, rows: [WindowRow]) -> CGWindowID? {
    let candidates = rows
        .filter { $0.pid == pid && convincinglyMatchesWindow(bounds, $0.bounds) }
        .map { (id: $0.id, distance: windowGeometryDistance(bounds, $0.bounds)) }
        .sorted { $0.distance < $1.distance }
    guard let winner = candidates.first else { return nil }
    if candidates.count > 1, candidates[1].distance - winner.distance < 32 { return nil }
    return winner.id
}

private func owningAXWindowID(
    _ element: AXUIElement,
    pid: pid_t,
    rows suppliedRows: [WindowRow]? = nil
) -> CGWindowID? {
    var current: AXUIElement? = element
    let deadline = ProcessInfo.processInfo.systemUptime + 2.0
    for _ in 0..<12 {
        if ProcessInfo.processInfo.systemUptime >= deadline { return nil }
        guard let candidate = current else { return nil }
        let window = axElementAttribute(candidate, kAXWindowAttribute as CFString) ??
            (axRole(candidate) == "Window" ? candidate : nil)
        if let window {
            if let exact = axWindowNumber(window) { return exact }
            if let bounds = axBounds(window) {
                return unambiguousWindowID(
                    bounds: bounds,
                    pid: pid,
                    rows: suppliedRows ?? allWindowRows(includeMinimized: false)
                )
            }
        }
        current = axElementAttribute(candidate, kAXParentAttribute as CFString)
    }
    return nil
}

private func focusedAXWindowID(for pid: pid_t, rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    guard AXIsProcessTrusted() else { return nil }
    let app = axApplication(pid)
    guard let focused = axElementAttribute(app, kAXFocusedWindowAttribute as CFString) else { return nil }
    if let exact = axWindowNumber(focused) { return exact }
    guard let bounds = axBounds(focused) else { return nil }
    let rows = suppliedRows ?? allWindowRows(includeMinimized: false)
    return unambiguousWindowID(bounds: bounds, pid: pid, rows: rows)
}

private func focusedAXElementWindowID(for pid: pid_t, rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    guard AXIsProcessTrusted() else { return nil }
    let app = axApplication(pid)
    guard let element = axElementAttribute(app, kAXFocusedUIElementAttribute as CFString) else { return nil }
    return owningAXWindowID(element, pid: pid, rows: suppliedRows)
}

private func inputTargetMatches(_ row: WindowRow) -> Bool {
    guard frontmostPID() == row.pid else { return false }
    let rows = allWindowRows(includeMinimized: false)
    guard windowServerFrontWindowID(rows: rows) == row.id else { return false }
    guard focusedAXWindowID(for: row.pid, rows: rows) == row.id else { return false }
    // Missing focused-control evidence is not agreement. AX can return nil on a timeout,
    // an untyped value or an app transition; accepting that would turn an unprovable
    // keyboard destination into global physical input.
    guard focusedAXElementWindowID(for: row.pid, rows: rows) == row.id else { return false }
    return true
}

private func assertInputTarget(_ id: CGWindowID) throws -> WindowRow {
    guard let row = windowRow(id), row.onScreen else {
        throw fail("INPUT_TARGET_LOST", "target window \(id) no longer exists on screen; no input was sent")
    }
    guard inputTargetMatches(row) else {
        throw fail("INPUT_TARGET_LOST", "window \(id) is no longer the exact active input target; no input was sent")
    }
    return row
}

private func setAXValueIfPossible(_ element: AXUIElement, _ attribute: CFString, _ value: CFTypeRef) {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, attribute, &settable) == .success,
          settable.boolValue else { return }
    _ = AXUIElementSetAttributeValue(element, attribute, value)
}

private func setAXBooleanIfPossible(_ element: AXUIElement, _ attribute: CFString, _ value: Bool) {
    setAXValueIfPossible(element, attribute, value ? kCFBooleanTrue : kCFBooleanFalse)
}

private func matchingAXWindow(_ row: WindowRow, deadline suppliedDeadline: TimeInterval? = nil) throws -> AXUIElement {
    try requireAccessibility()
    let app = axApplication(row.pid)
    let deadline = suppliedDeadline ?? (ProcessInfo.processInfo.systemUptime + maxAXTraversalSeconds)
    guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw fail("UIA_TIMEOUT", "accessibility window matching exceeded its bounded native deadline")
    }
    // The limit belongs at the AX copy boundary. Fetching the complete provider array and
    // applying prefix(64) afterwards would already have materialized unbounded native state.
    let windows = axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)
    for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw fail("UIA_TIMEOUT", "exact accessibility window matching exceeded its bounded native deadline")
        }
        if axWindowNumber(window) == row.id { return window }
    }
    var geometryCandidates: [(element: AXUIElement, distance: CGFloat)] = []
    for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw fail("UIA_TIMEOUT", "accessibility window matching exceeded its bounded native deadline")
        }
        guard let bounds = axBounds(window), convincinglyMatchesWindow(bounds, row.bounds) else { continue }
        geometryCandidates.append((window, windowGeometryDistance(bounds, row.bounds)))
    }
    geometryCandidates.sort { $0.distance < $1.distance }
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
    try requireAccessibility()
    if inputTargetMatches(row) { return true }
    guard let app = NSRunningApplication(processIdentifier: row.pid) else { return false }
    let window = try matchingAXWindow(row)
    var minimizedSettable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(window, kAXMinimizedAttribute as CFString, &minimizedSettable) == .success,
       minimizedSettable.boolValue {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    _ = app.activate(options: [.activateIgnoringOtherApps])
    let appElement = axApplication(row.pid)
    setAXBooleanIfPossible(appElement, kAXFrontmostAttribute as CFString, true)
    setAXValueIfPossible(appElement, kAXMainWindowAttribute as CFString, window)
    setAXValueIfPossible(appElement, kAXFocusedWindowAttribute as CFString, window)
    setAXBooleanIfPossible(window, kAXMainAttribute as CFString, true)
    setAXBooleanIfPossible(window, kAXFocusedAttribute as CFString, true)
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    let deadline = ProcessInfo.processInfo.systemUptime + 2.0
    while ProcessInfo.processInfo.systemUptime < deadline {
        if inputTargetMatches(row) { return true }
        usleep(20_000)
    }
    return false
}

private final class UISnapshot {
    let window: CGWindowID
    let windowBounds: CGRect
    let elements: [String: AXUIElement]

    init(window: CGWindowID, windowBounds: CGRect, elements: [String: AXUIElement]) {
        self.window = window
        self.windowBounds = windowBounds
        self.elements = elements
    }
}

private var nextSnapshotID = 1
private var snapshots: [Int: UISnapshot] = [:]
private var snapshotOrder: [Int] = []

private func rememberSnapshot(window: CGWindowID, windowBounds: CGRect, elements: [String: AXUIElement]) -> Int {
    let id = nextSnapshotID
    nextSnapshotID += 1
    snapshots[id] = UISnapshot(window: window, windowBounds: windowBounds, elements: elements)
    snapshotOrder.append(id)
    while snapshotOrder.count > 16 {
        let removed = snapshotOrder.removeFirst()
        snapshots.removeValue(forKey: removed)
    }
    return id
}

private func findUI(
    _ request: JSONObject,
    suppliedWindow: WindowRow? = nil
) throws -> JSONObject {
    // Window matching and control traversal are two phases of one native operation, not
    // two independent six-second allowances. The parent timeout can now safely outlive
    // this one aggregate deadline even though a synchronous addon call is not pre-emptible.
    let deadline = ProcessInfo.processInfo.systemUptime + maxAXTraversalSeconds
    let row: WindowRow
    if let suppliedWindow {
        row = suppliedWindow
    } else if let rawRequested = request["id"], !(rawRequested is NSNull) {
        guard let requested = number(rawRequested)?.uint32Value else {
            throw fail("BAD_REQUEST", "find_ui window id is malformed")
        }
        guard let found = windowRow(requested) else {
            throw fail("WINDOW_NOT_FOUND", "window \(requested) is no longer available")
        }
        row = found
    } else if let foreground = foregroundWindowID(), let found = windowRow(foreground) {
        row = found
    } else {
        throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")
    }
    let root = try matchingAXWindow(row, deadline: deadline)
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
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw fail("UIA_TIMEOUT", "accessibility traversal exceeded its bounded native deadline")
        }
        let element = queue[cursor]
        cursor += 1
        visited += 1
        let remainingBudget = max(0, maxVisited - queue.count)
        if remainingBudget > 0 {
            queue.append(contentsOf: axChildren(element, limit: remainingBudget))
        }

        let role = axRole(element)
        let name = axName(element)
        let identifier = boundedAXString(axString(element, kAXIdentifierAttribute as CFString) ?? "")
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

    let snapshotID = rememberSnapshot(window: row.id, windowBounds: row.bounds, elements: retained)
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
    try requirePointOnActiveDisplay(point)
    try postMouse(.mouseMoved, point: point, button: .left)
}

private func click(_ point: CGPoint, button: CGMouseButton, count: Int, targetWindow: CGWindowID? = nil) throws {
    try requirePointOnActiveDisplay(point)
    let (down, up, _) = mouseTypes(button)
    for clickIndex in 1...count {
        if let targetWindow { _ = try assertInputTarget(targetWindow) }
        try postMouse(down, point: point, button: button, clickState: Int64(clickIndex))
        do {
            if let targetWindow { _ = try assertInputTarget(targetWindow) }
            try postMouse(up, point: point, button: button, clickState: Int64(clickIndex))
        } catch {
            // Release the button even if focus changed after mouse-down; never leave a
            // system-wide synthetic button held while reporting the target-loss failure.
            try? postMouse(up, point: point, button: button, clickState: Int64(clickIndex))
            throw error
        }
        usleep(35_000)
    }
}

private func drag(
    _ xs: [NSNumber],
    _ ys: [NSNumber],
    button: CGMouseButton,
    targetWindow: CGWindowID? = nil
) throws {
    guard xs.count == ys.count, xs.count >= 2 else { throw fail("BAD_ACTION", "drag needs at least two points") }
    let points = zip(xs, ys).map { CGPoint(x: $0.0.doubleValue, y: $0.1.doubleValue) }
    let displays = try activeDisplayRects()
    for point in points { try requirePointOnActiveDisplay(point, displays: displays) }
    let (down, up, dragged) = mouseTypes(button)
    if let targetWindow { _ = try assertInputTarget(targetWindow) }
    try postMouse(down, point: points[0], button: button)
    var current = points[0]
    do {
        for point in points.dropFirst() {
            if let targetWindow { _ = try assertInputTarget(targetWindow) }
            try postMouse(dragged, point: point, button: button)
            current = point
            usleep(12_000)
        }
        if let targetWindow { _ = try assertInputTarget(targetWindow) }
        try postMouse(up, point: points[points.count - 1], button: button)
    } catch {
        try? postMouse(up, point: current, button: button)
        throw error
    }
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

private let modifierFlags: [String: CGEventFlags] = [
    "command": .maskCommand,
    "shift": .maskShift,
    "rightshift": .maskShift,
    "option": .maskAlternate,
    "rightoption": .maskAlternate,
    "control": .maskControl,
    "rightcontrol": .maskControl,
    "capslock": .maskAlphaShift
]

private func normalizedKeyName(_ name: String) -> String {
    switch name.lowercased() {
    case "cmd", "meta": return "command"
    case "alt": return "option"
    case "ctrl": return "control"
    case "esc": return "escape"
    default: return name.lowercased()
    }
}

private func isSystemShortcut(_ names: [String]) -> Bool {
    let keys = Set(names)
    if !keys.isDisjoint(with: ["volumeup", "volumedown", "mute"]) { return true }
    if keys.contains(where: { name in
        guard name.hasPrefix("f"), let value = Int(name.dropFirst()) else { return false }
        return (1...20).contains(value)
    }) { return true }
    if keys.contains("command") && (keys.contains("tab") || keys.contains("space")) { return true }
    if keys.contains("command") && keys.contains("option") && keys.contains("escape") { return true }
    if keys.contains("control") && !keys.isDisjoint(with: ["left", "right", "up", "down"]) { return true }
    if keys.contains("control") && keys.contains("space") { return true }
    if keys.contains("command") && keys.contains("shift") && !keys.isDisjoint(with: ["3", "4", "5"]) { return true }
    return false
}

private struct ResolvedKey {
    let code: CGKeyCode
    let requiredFlags: CGEventFlags
}

private func currentLayoutKey(for logicalName: String) -> ResolvedKey? {
    let source = TISCopyCurrentKeyboardLayoutInputSource().takeRetainedValue()
    guard let rawData = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = unsafeBitCast(rawData, to: CFData.self)
    guard let bytes = CFDataGetBytePtr(data) else { return nil }
    let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
    let modifierCandidates: [(carbon: UInt32, event: CGEventFlags)] = [
        (0, []),
        (UInt32(shiftKey >> 8), .maskShift),
        (UInt32(optionKey >> 8), .maskAlternate),
        (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate])
    ]

    for candidate in modifierCandidates {
        for rawCode in 0..<128 {
            var deadKeyState: UInt32 = 0
            var actualLength = 0
            var characters = Array<UniChar>(repeating: 0, count: 8)
            let status = characters.withUnsafeMutableBufferPointer { buffer in
                UCKeyTranslate(
                    layout,
                    UInt16(rawCode),
                    UInt16(kUCKeyActionDisplay),
                    candidate.carbon,
                    UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysMask),
                    &deadKeyState,
                    buffer.count,
                    &actualLength,
                    buffer.baseAddress!
                )
            }
            guard status == noErr, actualLength > 0 else { continue }
            let rendered = characters.withUnsafeBufferPointer {
                String(utf16CodeUnits: $0.baseAddress!, count: Int(actualLength))
            }
            if rendered.lowercased() == logicalName.lowercased() {
                return ResolvedKey(code: CGKeyCode(rawCode), requiredFlags: candidate.event)
            }
        }
    }
    return nil
}

private func resolveKey(_ name: String) throws -> ResolvedKey {
    if name.count == 1 {
        guard let resolved = currentLayoutKey(for: name) else {
            throw fail("BAD_KEY", "active keyboard layout does not expose logical key \(name)")
        }
        return resolved
    }
    guard let code = keyCodes[name] else { throw fail("BAD_KEY", "unknown key \(name)") }
    return ResolvedKey(code: code, requiredFlags: [])
}

private func pressKeys(_ names: [String], targetWindow: CGWindowID? = nil) throws {
    let normalized = names.map(normalizedKeyName)
    let resolved = try normalized.map(resolveKey)
    let globalShortcut = isSystemShortcut(normalized)
    guard let source = CGEventSource(stateID: .privateState) else {
        throw fail("INPUT_FAILED", "could not create a keyboard event source")
    }
    var targetPID: pid_t?
    if let targetWindow { targetPID = try assertInputTarget(targetWindow).pid }

    func postKey(_ code: CGKeyCode, keyDown: Bool, flags: CGEventFlags) throws {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown) else {
            throw fail("INPUT_FAILED", "could not create a keyboard event")
        }
        event.flags = flags
        if globalShortcut { event.post(tap: .cghidEventTap) }
        else if let targetPID { event.postToPid(targetPID) }
        else { event.post(tap: .cghidEventTap) }
    }

    var flags: CGEventFlags = []
    let modifierIndices = normalized.indices.filter { modifierFlags[normalized[$0]] != nil }
    let ordinaryIndices = normalized.indices.filter { modifierFlags[normalized[$0]] == nil }
    var pressedModifierIndices: [Int] = []
    do {
        if let targetWindow { targetPID = try assertInputTarget(targetWindow).pid }
        for index in modifierIndices {
            guard let flag = modifierFlags[normalized[index]] else { continue }
            flags.insert(flag)
            try postKey(resolved[index].code, keyDown: true, flags: flags)
            pressedModifierIndices.append(index)
        }
        // A window transition while modifiers are down must abort before the ordinary key.
        if let targetWindow { targetPID = try assertInputTarget(targetWindow).pid }
        for index in ordinaryIndices {
            try postKey(resolved[index].code, keyDown: true, flags: flags.union(resolved[index].requiredFlags))
        }
        usleep(35_000)
        for index in ordinaryIndices.reversed() {
            try postKey(resolved[index].code, keyDown: false, flags: flags.union(resolved[index].requiredFlags))
        }
        for index in pressedModifierIndices.reversed() {
            guard let flag = modifierFlags[normalized[index]] else { continue }
            flags.remove(flag)
            try postKey(resolved[index].code, keyDown: false, flags: flags)
        }
    } catch {
        for index in pressedModifierIndices.reversed() {
            guard let flag = modifierFlags[normalized[index]] else { continue }
            flags.remove(flag)
            try? postKey(resolved[index].code, keyDown: false, flags: flags)
        }
        throw error
    }
}

private func typeText(_ text: String, targetWindow: CGWindowID? = nil) throws {
    guard let source = CGEventSource(stateID: .privateState) else {
        throw fail("INPUT_FAILED", "could not create a keyboard event source")
    }
    let units = Array(text.utf16)
    var cursor = 0
    while cursor < units.count {
        var end = min(units.count, cursor + 32)
        if end < units.count, end > cursor,
           units[end - 1] >= 0xD800, units[end - 1] <= 0xDBFF,
           units[end] >= 0xDC00, units[end] <= 0xDFFF {
            end -= 1
        }
        let chunk = Array(units[cursor..<end])
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw fail("INPUT_FAILED", "could not create a text input event")
        }
        chunk.withUnsafeBufferPointer { pointer in
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
        }
        if let targetWindow {
            let target = try assertInputTarget(targetWindow)
            down.postToPid(target.pid)
            up.postToPid(target.pid)
        } else {
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
        cursor = end
    }
}

private func cursorObject() -> JSONObject {
    let location = CGEvent(source: nil)?.location ?? .zero
    return ["x": Int(location.x.rounded()), "y": Int(location.y.rounded())]
}

private func actUI(_ request: JSONObject) throws -> JSONObject {
    try requireAccessibility()
    let snapshotID = int(request["snapshotId"])
    let runtimeKey = string(request["runtimeKey"])
    guard let snapshot = snapshots[snapshotID] else {
        throw fail(
            "STALE_UI_SNAPSHOT",
            "UI snapshot \(snapshotID) is no longer retained; retained snapshots: \(snapshotOrder.map(String.init).joined(separator: ","))"
        )
    }
    let requestedWindow = number(request["id"])?.uint32Value
    guard snapshot.window == requestedWindow else {
        throw fail(
            "STALE_UI_SNAPSHOT",
            "UI snapshot \(snapshotID) belongs to window \(snapshot.window), but the action requested window \(requestedWindow.map(String.init) ?? "missing")"
        )
    }
    guard let element = snapshot.elements[runtimeKey] else {
        throw fail("UNKNOWN_UI_REF", "the UI element no longer exists in snapshot \(snapshotID)")
    }
    guard let currentWindow = windowRow(snapshot.window),
          axPID(element) == currentWindow.pid,
          owningAXWindowID(element, pid: currentWindow.pid) == snapshot.window else {
        throw fail(
            "STALE_UI_SNAPSHOT",
            "the referenced accessibility control no longer belongs to snapshot window \(snapshot.window)"
        )
    }
    // Mutation requires an explicitly readable true value. Missing, untyped or timed-out
    // AXEnabled evidence is not permission to click through the uncertainty.
    guard axBool(element, kAXEnabledAttribute as CFString, default: false) else {
        throw fail("UI_ACTION_DISABLED", "the referenced accessibility control is disabled")
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
            guard let live = windowRow(snapshot.window),
                  live.bounds.integral == snapshot.windowBounds.integral else {
                throw fail("STALE_UI_SNAPSHOT", "the UI snapshot window moved or resized")
            }
            guard let bounds = axBounds(element), !bounds.isEmpty else {
                throw fail("UI_ACTION_FAILED", "the control exposes neither AXPress nor usable bounds")
            }
            guard let row = windowRow(snapshot.window),
                  row.onScreen,
                  row.bounds.insetBy(dx: -24, dy: -24).contains(CGPoint(x: bounds.midX, y: bounds.midY)) else {
                throw fail("STALE_UI_SNAPSHOT", "the control is no longer inside snapshot window \(snapshot.window)")
            }
            try click(
                CGPoint(x: bounds.midX, y: bounds.midY),
                button: .left,
                count: 1,
                targetWindow: snapshot.window
            )
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
        _ = try assertFrameTarget(frame)
    } else {
        guard let expectedDisplays = displayTopology(frame["displays"]) else {
            throw fail("STALE_FRAME", "the screen frame has no exact display topology")
        }
        let currentDisplays = try activeDisplayRects()
        guard sameDisplayTopology(expectedDisplays, currentDisplays) else {
            throw fail("STALE_FRAME", "active display topology changed after the screenshot")
        }
        let screen = currentDisplays.reduce(CGRect.null) { $0.union($1) }
        guard screen.contains(region) else { throw fail("STALE_FRAME", "desktop geometry changed after the screenshot") }
    }
}

@discardableResult
private func assertFrameTarget(_ frame: JSONObject) throws -> CGWindowID? {
    guard let region = rect(frame["region"]) else { throw fail("STALE_FRAME", "the coordinate frame is malformed") }
    if let windowID = number(frame["window"])?.uint32Value {
        guard let row = windowRow(windowID), row.onScreen else {
            throw fail("STALE_FRAME", "target window \(windowID) is no longer drawable")
        }
        let expected = rect(frame["windowGeometry"]) ?? region
        guard row.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) moved or resized after the screenshot")
        }
        _ = try assertInputTarget(windowID)
        return windowID
    }
    guard let expectedDisplays = displayTopology(frame["displays"]) else {
        throw fail("STALE_FRAME", "the screen frame has no exact display topology")
    }
    let currentDisplays = try activeDisplayRects()
    guard sameDisplayTopology(expectedDisplays, currentDisplays) else {
        throw fail("STALE_FRAME", "active display topology changed after the screenshot")
    }
    let screen = currentDisplays.reduce(CGRect.null) { $0.union($1) }
    guard screen.contains(region) else { throw fail("STALE_FRAME", "desktop geometry changed after the screenshot") }
    return nil
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
    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    let bytes = (attributes[.size] as? NSNumber)?.intValue ?? Int.max
    guard bytes <= maxEncodedScreenshotBytes else {
        try? FileManager.default.removeItem(atPath: path)
        throw fail(
            "SCREENSHOT_TOO_LARGE",
            "encoded PNG is \(bytes) bytes; limit \(maxEncodedScreenshotBytes) bytes"
        )
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
    guard #available(macOS 14.0, *) else {
        // Pre-14 direct window capture cannot disable the window shadow. Returning that
        // shadow-bearing bitmap against the shadow-free WindowServer frame would make every
        // screenshot coordinate dishonest, so visible windows use the screen fallback.
        throw fail("CAPTURE_GEOMETRY_UNSAFE", "shadow-free direct window capture requires macOS 14")
    }
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw fail("WINDOW_NOT_FOUND", "no window with id \(windowID) is available for capture")
    }
    let region = window.frame
    guard approximatelyEqual(region, expectedGeometry) else {
        throw fail("STALE_FRAME", "window \(windowID) changed geometry before capture")
    }
    let (width, height) = scaledDimensions(region: region, maxWidth: maxWidth)
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = true
    configuration.ignoreShadowsSingleWindow = true
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
    } else {
        // The 12.3 SDK surface cannot bound the decoded allocation before the first frame.
        // Reject a native 5K/6K source rather than materialising it inside Electron and only
        // discovering after the fact that it exceeded the advertised pixel ceiling.
        guard Double(display.width) * Double(display.height) <= Double(maxDecodedScreenshotPixels) else {
            throw fail("SCREEN_TOO_LARGE", "native display capture exceeds the decoded-pixel budget on macOS 12")
        }
    }
    configuration.showsCursor = true
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let image = try captureImage(filter: filter, configuration: configuration)
    return (try resizedImage(image, width: width, height: height), region)
}

private func captureComposite(
    region target: CGRect,
    maxWidth: Int,
    displays: [SCDisplay],
    expectedDisplays: [CGRect]
) throws -> CGImage {
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
        guard sameDisplayTopology(expectedDisplays, try activeDisplayRects()) else {
            throw fail("STALE_FRAME", "active display topology changed while screenshot capture was in progress")
        }
        let (image, displayRegion) = try captureDisplay(display, maxWidth: display.width)
        guard sameDisplayTopology(expectedDisplays, try activeDisplayRects()) else {
            throw fail("STALE_FRAME", "active display topology changed while screenshot capture was in progress")
        }
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
    let displayRects = try activeDisplayRects()
    let screen = displayRects.reduce(CGRect.null) { $0.union($1) }
    let content = try shareableContent()
    let contentDisplayRects = content.displays.map(\.frame)
    guard sameDisplayTopology(displayRects, contentDisplayRects) else {
        throw fail("STALE_FRAME", "active display topology changed before screenshot capture began")
    }
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
            let canUseVisibleFallback = row.onScreen && [
                "WINDOW_NOT_FOUND",
                "CAPTURE_FAILED",
                "CAPTURE_TIMEOUT",
                "CAPTURE_GEOMETRY_UNSAFE"
            ].contains(error.code)
            guard canUseVisibleFallback else { throw error }
            region = row.bounds
            image = try captureComposite(
                region: region,
                maxWidth: maxWidth,
                displays: content.displays,
                expectedDisplays: displayRects
            )
            captureMode = "screen_fallback"
        }
        guard let fresh = windowRow(requestedWindow), approximatelyEqual(fresh.bounds, row.bounds) else {
            throw fail("STALE_FRAME", "window \(requestedWindow) moved or resized while it was captured")
        }
    } else if let requestedRegion = rect(request["region"]) {
        region = requestedRegion
        image = try captureComposite(
            region: region,
            maxWidth: maxWidth,
            displays: content.displays,
            expectedDisplays: displayRects
        )
        captureMode = "screen"
    } else if bool(request["full"]) {
        region = screen
        image = try captureComposite(
            region: region,
            maxWidth: maxWidth,
            displays: content.displays,
            expectedDisplays: displayRects
        )
        captureMode = "screen"
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw fail("SCREEN_UNAVAILABLE", "ScreenCaptureKit reported no display")
        }
        (image, region) = try captureDisplay(display, maxWidth: maxWidth)
        captureMode = "screen"
    }
    guard sameDisplayTopology(displayRects, try activeDisplayRects()) else {
        throw fail("STALE_FRAME", "active display topology changed while screenshot was captured")
    }
    try writePNG(image, path: file)
    var response: JSONObject = [
        "region": rectObject(region),
        "image": ["width": image.width, "height": image.height],
        "screen": rectObject(screen),
        "displays": displayTopologyObject(displayRects),
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
                let ui = try findUI(request, suppliedWindow: row)
                for key in ["snapshotId", "elements", "visited", "truncated"] {
                    result[key] = ui[key]
                }
            } catch let error as HelperFailure where error.code == "ACCESSIBILITY_PERMISSION_REQUIRED" {
                result["uiUnavailable"] = ["code": error.code, "message": error.message]
            }
        }
    case "act":
        try requireAccessibility()
        let frame = request["frame"] as? JSONObject
        if let frame { try validateFrame(frame) }
        let frameWindow = number(frame?["window"])?.uint32Value
        // A successful semantic or explicit focus step becomes the authority for later
        // keyboard input in this same batch. The later input still re-proves exact focus;
        // carrying the id prevents a frame-less click_ref -> type sequence from degrading
        // into an unscoped global HID event.
        var inputWindow = frameWindow
        let actions = request["actions"] as? [JSONObject] ?? []
        var routes: [String] = []
        var completed = 0
        for (index, action) in actions.enumerated() {
            do {
                let type = string(action["type"])
                switch type {
                case "click_ui", "set_value_ui":
                    guard let actionWindow = number(action["window"])?.uint32Value else {
                        throw fail("BAD_ACTION", "semantic action has no target window")
                    }
                    if let frameWindow, frameWindow != actionWindow {
                        throw fail(
                            "TARGET_WINDOW_CONFLICT",
                            "semantic action targets window \(actionWindow), but frame targets window \(frameWindow)"
                        )
                    }
                    var uiRequest = action
                    uiRequest["id"] = action["window"]
                    uiRequest["action"] = type == "click_ui" ? "click" : "set_value"
                    uiRequest["value"] = action["value"]
                    let reply = try actUI(uiRequest)
                    routes.append(string(reply["route"], default: "uia"))
                    inputWindow = actionWindow
                case "move":
                    if let frame { _ = try assertFrameTarget(frame) }
                    try movePointer(CGPoint(x: int(action["x"]), y: int(action["y"])))
                    routes.append("sendinput")
                case "click", "double_click":
                    if let frame { _ = try assertFrameTarget(frame) }
                    try click(
                        CGPoint(x: int(action["x"]), y: int(action["y"])),
                        button: mouseButton(string(action["button"])),
                        count: type == "double_click" ? 2 : 1,
                        targetWindow: frameWindow
                    )
                    routes.append("sendinput")
                case "scroll":
                    if let frame { _ = try assertFrameTarget(frame) }
                    try movePointer(CGPoint(x: int(action["x"]), y: int(action["y"])))
                    if let frame { _ = try assertFrameTarget(frame) }
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
                    if let frame { _ = try assertFrameTarget(frame) }
                    try drag(
                        action["xs"] as? [NSNumber] ?? [],
                        action["ys"] as? [NSNumber] ?? [],
                        button: mouseButton(string(action["button"])),
                        targetWindow: frameWindow
                    )
                    routes.append("sendinput")
                case "type":
                    if let inputWindow { _ = try assertInputTarget(inputWindow) }
                    try typeText(string(action["text"]), targetWindow: inputWindow)
                    routes.append("sendinput")
                case "keypress":
                    if let inputWindow { _ = try assertInputTarget(inputWindow) }
                    try pressKeys(action["keys"] as? [String] ?? [], targetWindow: inputWindow)
                    routes.append("sendinput")
                case "focus":
                    let requested = CGWindowID(int(action["window"]))
                    if let frameWindow, frameWindow != requested {
                        throw fail(
                            "TARGET_WINDOW_CONFLICT",
                            "focus targets window \(requested), but frame targets window \(frameWindow)"
                        )
                    }
                    guard try focusWindow(requested) else {
                        throw fail("FOCUS_FAILED", "the requested window could not be activated")
                    }
                    routes.append("focus")
                    inputWindow = requested
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

#if COS_DESKTOP_ADDON
@_cdecl("cos_desktop_handle_json")
public func cosDesktopHandleJSON(_ request: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let request else { return strdup("{\"ok\":false,\"error_code\":\"BAD_REQUEST\",\"message\":\"missing JSON request\"}") }
    return autoreleasepool {
        let object = response(for: String(cString: request))
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else {
            return strdup("{\"ok\":false,\"error_code\":\"HELPER_ERROR\",\"message\":\"response serialization failed\"}")
        }
        return strdup(json)
    }
}

@_cdecl("cos_desktop_free_json")
public func cosDesktopFreeJSON(_ value: UnsafeMutablePointer<CChar>?) {
    free(value)
}
#else
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
#endif

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
        let process = boundedAXString(string(item[kCGWindowOwnerName as String], default: "Process \(pid)"))
        let title = boundedAXString(
            string(item[kCGWindowName as String]).trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let displayTitle = boundedAXString(title.isEmpty ? "\(process) window" : title)
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

/**
 * Which application is active, read fresh rather than from a cache nobody is refilling.
 *
 * `NSWorkspace.shared.frontmostApplication` is served from an internal running-applications
 * cache that AppKit keeps current by delivering notifications on a run loop. The standalone
 * helper has none: it reads commands with `readLine()` on the main thread and never returns to
 * a run loop, so the cache is fixed at first access and every application launched afterwards
 * stays invisible to it — for the life of the process.
 *
 * The app runs one long-lived helper, which makes that permanent. QA reproduced it directly:
 * two helpers on the same desktop at the same moment, one that had queried before TextEdit was
 * launched and one started after. The first reported no foreground window and kept doing so; the
 * second was correct throughout. Window *enumeration* was fine either way, because that goes
 * through CGWindowListCopyWindowInfo — so the window was listed, capturable and visibly in
 * front, while nothing would call it foreground. That is the `No foreground window` the release
 * was held for, and it is a second, independent cause of the same symptom as the transient
 * child-window case fixed earlier.
 *
 * Draining the run loop's ready sources first lets those pending notifications arrive. Bounded
 * and non-blocking: each pass returns immediately when there is nothing to deliver, and in the
 * in-process build — where Electron's main thread is already running a real run loop — there is
 * never anything pending here and the loop exits on its first pass.
 */
private func frontmostPID() -> pid_t? {
    onMainQueue {
        var drained = 0
        while drained < 32, CFRunLoopRunInMode(.defaultMode, 0, true) == .handledSource {
            drained += 1
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
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
    // Read the focused window once and use that one answer for both decisions below.
    //
    // These used to be two separate queries of the same fact: frontWindowID asked which window
    // has AX focus in order to resolve an app's transient child windows, and then this function
    // asked again to check they agreed. Between the two reads focus can move — a bubble opens, a
    // popup closes — and the second answer disagreeing with the first was read as "an app
    // transition is in flight" and reported as no foreground window at all. QA saw exactly that:
    // `No foreground window` while Chrome plainly occupied the screen, correcting itself as soon
    // as anything was refocused. One read cannot disagree with itself.
    let focused = AXIsProcessTrusted() ? focusedAXWindowID(for: pid, rows: rows) : nil
    guard let frontID = frontWindowID(rows: rows, focusedWindow: focused),
          let front = rows.first(where: { $0.id == frontID }),
          front.pid == pid else { return nil }
    // Screen-only observation must still work without Accessibility. When AX is available,
    // genuine disagreement still means a transition is in flight, so expose no active window
    // rather than attributing input or pixels to stale state from either subsystem.
    if let focused, focused != front.id { return nil }
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

/**
 * What sits under a screen point, across every application.
 *
 * A scroll wheel is delivered by the window server to whatever is under the pointer, not to
 * whatever holds the lease. When a scroll reports success and the document has not moved, the
 * usual reason is that some other window was under that point — and an answer that only says
 * "sent" cannot tell that apart from "the app ignored it". So read it back.
 */
private func elementUnderPointer(_ point: CGPoint) -> AXUIElement? {
    var element: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(
        AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element
    )
    return status == .success ? element : nil
}

/**
 * How far the scroller nearest this element has travelled, 0...1, or nil when nothing scrolls here.
 *
 * The scroll bar carries the position as a fraction, which is all that is needed to answer "did it
 * move": comparing the same fraction before and after needs no knowledge of the document at all.
 */
private func scrollFraction(near element: AXUIElement) -> Double? {
    var current: AXUIElement? = element
    for _ in 0..<8 {
        guard let node = current else { return nil }
        if let bar = axElementAttribute(node, "AXVerticalScrollBar" as CFString),
           let value = axAttribute(bar, "AXValue" as CFString) as? NSNumber {
            return value.doubleValue
        }
        current = axElementAttribute(node, "AXParent" as CFString)
    }
    return nil
}

/**
 * Wait only as long as the scroll actually takes, then read it.
 *
 * This was a flat 120 ms, chosen without a measurement, and a QA run supplied the measurement:
 * ten scrolls cost 2495 ms, 234 ms each, while the scroller itself finished moving after 21 to
 * 26 ms — the wait was roughly five times the thing it was waiting for, on every single scroll.
 *
 * A shorter flat number would have been a second guess. Polling until two readings agree costs
 * about 30 ms where 120 was spent, and — unlike any fixed figure — it still waits for an
 * application whose scrolling is animated rather than instant, which the measurement explicitly
 * did not cover. The 120 ms survives as the ceiling, so nothing can wait longer than before.
 *
 * "Nothing can wait longer than before" held only in requested microseconds, not on the clock. A
 * later QA round measured the actual ceiling at 145–348 ms and traced it here: the loop counted
 * `elapsed` by adding the *requested* 10_000 µs each turn, never the time `usleep` had actually
 * spent — and `usleep(10_000)` measured a median 12.06 ms on that machine, over the nominal
 * request before a single read even ran. Twelve turns of that under-count alone reach 145 ms
 * before the requested total says 120. `systemUptime`, the deadline idiom every other wait in
 * this file already uses, reads the clock instead of trusting the request.
 */
private func settledScrollState(_ point: CGPoint, startedAt start: Double?) -> (pid: pid_t?, role: String?, fraction: Double?) {
    // Nothing scrollable is under the pointer, so there is no reading to settle. Give the
    // application a moment anyway — the answer still reports what was hit.
    guard let start else {
        usleep(30_000)
        return pointerScrollState(point)
    }
    var last: (pid: pid_t?, role: String?, fraction: Double?) = (nil, nil, nil)
    var moved = false
    let deadline = ProcessInfo.processInfo.systemUptime + 0.120
    while ProcessInfo.processInfo.systemUptime < deadline {
        usleep(10_000)
        let current = pointerScrollState(point)
        guard let now = current.fraction else { return current }
        // Two readings agree only once the scroll has actually begun. Comparing a reading to
        // itself before then would answer "nothing moved" at 10 ms, which is a third of the way
        // to the movement even starting — the measurement puts that at 21 to 26 ms.
        if now != start { moved = true }
        if moved, let previous = last.fraction, previous == now { return current }
        last = current
    }
    return last.fraction == nil ? pointerScrollState(point) : last
}

private func pointerScrollState(_ point: CGPoint) -> (pid: pid_t?, role: String?, fraction: Double?) {
    guard let element = elementUnderPointer(point) else { return (nil, nil, nil) }
    var pid: pid_t = 0
    let owner = AXUIElementGetPid(element, &pid) == .success ? pid : nil
    return (owner, axString(element, "AXRole" as CFString), scrollFraction(near: element))
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axAttribute(element, attribute) as? String
}

private func axBool(_ element: AXUIElement, _ attribute: CFString, default fallback: Bool) -> Bool {
    axOptionalBool(element, attribute) ?? fallback
}

/** Nil when the control publishes no readable boolean, which is not the same as false. */
private func axOptionalBool(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    (axAttribute(element, attribute) as? NSNumber)?.boolValue
}

/**
 * A comparable snapshot of a control's own reported value, when it has one.
 *
 * `AnyObject` bridges every AXValue shape this actually returns for a value worth comparing —
 * `NSNumber` for a checkbox or switch, `NSString` for a text control — to something `isEqual`
 * can judge. Nil is not "empty" or "false"; it is "this control publishes no comparable value
 * at all", which an ordinary action button does not, and must stay distinguishable from a
 * value that was read and did not change.
 *
 * A Chromium accessibility tree answers `AXValue` with an empty string for a control that has
 * nothing to say about its own state, rather than omitting the attribute the way AppKit does —
 * measured on both a `PopUpButton` (the extension's own toolbar icon) and a real
 * `<input type="checkbox">` inside its popup. An empty string still equals itself, so treating
 * it as a genuine value reported `changed: false` — "nothing changed" — for both, when the
 * honest answer this function exists to give is "nothing to compare".
 */
private func axComparableValue(_ element: AXUIElement) -> NSObject? {
    guard let value = axAttribute(element, kAXValueAttribute as CFString) as? NSObject else { return nil }
    if let text = value as? String, text.isEmpty { return nil }
    return value
}

/** Whether accessibility itself says this control's value can be written. */
private func axValueIsSettable(_ element: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success else {
        return false
    }
    return settable.boolValue
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

/**
 * Whether two titles name the same window, when one of them carries decoration the other does not.
 *
 * A window's accessibility title and its title in the window list are not the same string. Chrome
 * lists "Example Domain" and answers "Example Domain - Google Chrome - mydealz" — the browser name
 * and the profile appended. Comparing them for equality therefore matched nothing, and the tie-break
 * built on it did nothing at all for the application it was written for: a QA run met two Chrome
 * windows of identical size with plainly different titles and still could not address either.
 *
 * Containment is the honest relation between them. It is one-sided by design: if two windows both
 * carry the shorter title, they remain ambiguous, which is correct.
 */
/**
 * Whether a failure was only about reading the accessibility tree, leaving a capture still valid.
 *
 * This was written as a list of codes to let through, and a list is wrong for the job: splitting
 * `UIA_AMBIGUOUS_WINDOW` out of `UIA_FAILED` last round quietly took the new code off it, so a
 * snapshot of a window this scan cannot tell apart returned neither the tree *nor* the picture —
 * while asking for the picture alone still worked, and while the very same call on a window with no
 * accessibility representation at all returned both. The refusal even advised moving one of the
 * windows, which is exactly what the picture would have helped with.
 *
 * Asking what the failure *is* survives the next split. Only a target-identity failure — the window
 * is gone, moving, or was never named — invalidates the capture too.
 */
private func onlyTheTreeFailed(_ code: String) -> Bool {
    switch code {
    case "WINDOW_NOT_FOUND", "WINDOW_MOVING", "BAD_REQUEST":
        return false
    default:
        return true
    }
}

private func titlesAgree(_ a: String?, _ b: String?) -> Bool {
    guard let a, let b, !a.isEmpty, !b.isEmpty else { return false }
    return a == b || a.contains(b) || b.contains(a)
}

private func axWindowNumber(_ element: AXUIElement) -> CGWindowID? {
    (axAttribute(element, "AXWindowNumber" as CFString) as? NSNumber)?.uint32Value
}

private func axPID(_ element: AXUIElement) -> pid_t? {
    var pid = pid_t()
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

/**
 * Which listed window an accessibility window is, when the id it should carry does not exist.
 *
 * `title` is not optional decoration; leaving it out is what made the previous round's fix useless
 * in practice. The title tie-break went into `matchingAXWindow`, which turns a row into an element,
 * and not into this, which turns an element back into a row — and every focus and every input
 * target goes through here. So `find_ui` could tell two identical windows apart while any batch
 * beginning with `focus` still failed, and a focus that had actually worked was reported as
 * FOCUS_FAILED because the window that came to the front could not be attributed. Two independent
 * QA runs met that same message from opposite directions.
 */
private func unambiguousWindowID(
    bounds: CGRect,
    pid: pid_t,
    rows: [WindowRow],
    title: String? = nil
) -> CGWindowID? {
    let candidates = rows
        .filter { $0.pid == pid && convincinglyMatchesWindow(bounds, $0.bounds) }
        .map { (id: $0.id, title: $0.title, distance: windowGeometryDistance(bounds, $0.bounds)) }
        .sorted { $0.distance < $1.distance }
    guard let winner = candidates.first else { return nil }
    guard candidates.count > 1, candidates[1].distance - winner.distance < 32 else { return winner.id }
    // Geometry cannot separate them. The title often can, and it is already here.
    if let title, !title.isEmpty {
        let titled = candidates.filter { titlesAgree(title, $0.title) }
        if titled.count == 1 { return titled[0].id }
    }
    return nil
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
                    rows: suppliedRows ?? allWindowRows(includeMinimized: false),
                    title: axString(window, kAXTitleAttribute as CFString)
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
    return unambiguousWindowID(
        bounds: bounds,
        pid: pid,
        rows: rows,
        title: axString(focused, kAXTitleAttribute as CFString)
    )
}

private func focusedAXElementWindowID(for pid: pid_t, rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    guard AXIsProcessTrusted() else { return nil }
    let app = axApplication(pid)
    guard let element = axElementAttribute(app, kAXFocusedUIElementAttribute as CFString) else { return nil }
    return owningAXWindowID(element, pid: pid, rows: suppliedRows)
}

/**
 * The front window, with one application's own transient child windows resolved by AX.
 *
 * WindowServer z-order answers "what is on top", which is not the same question as "which
 * window receives keyboard input". Chrome's link-preview bubble and its omnibox popup are
 * ordinary layer-0 windows of the browser that legitimately sit above the window the user is
 * typing in. Reading the topmost one as the front window made `observe` report no foreground
 * window at all while Chrome was plainly active, and made `focusWindow` poll a condition it
 * could never satisfy until the bubble happened to disappear.
 *
 * Across applications nothing is relaxed. A window owned by another process still wins the
 * z-order comparison, and every caller separately requires the answer to belong to
 * `frontmostPID()`, so a covering window from another app still refuses input. The
 * resolution applies only inside the frontmost application, where `AXFocusedWindow` is by
 * definition the authority on where that application's keyboard input goes — and it is only
 * trusted when it names a window this scan already saw and admitted.
 */
private func frontWindowID(rows: [WindowRow], focusedWindow: CGWindowID? = nil) -> CGWindowID? {
    guard let top = windowServerFrontWindowID(rows: rows) else { return nil }
    guard let topRow = rows.first(where: { $0.id == top }), frontmostPID() == topRow.pid else { return top }
    // A caller that has already read the focused window passes it in, so the two of us cannot
    // reach different conclusions from two reads taken moments apart.
    guard let focused = focusedWindow ?? focusedAXWindowID(for: topRow.pid, rows: rows),
          focused != top else { return top }
    guard rows.contains(where: { $0.id == focused && $0.pid == topRow.pid }) else { return top }
    return focused
}

/**
 * A note for whoever next reads `INPUT_TARGET_LOST` against a browser and files it as a bug.
 *
 * It is usually not one, and it is not specific to this helper. The last clause below asks the
 * application which control has keyboard focus. A browser answers that only when the *page* has
 * a focused control it exposes to accessibility: measured on 2026-09-04, macOS Chrome on
 * `chatgpt.com` with the composer focused resolved `AXFocusedUIElement` to an `AXTextArea` and
 * input was delivered normally, while the same Chrome on a plain page with nothing focused could
 * not be read at all (AppleScript saw `-1728`, "cannot be read") and every action was refused.
 * Repeated deep AX walks of the window do not change it — it is a property of the page, not a
 * lazily-activated process-wide tree.
 *
 * The consequence is a real corner and worth stating plainly: `computer` cannot click *into* a
 * web page that has nothing focused yet, because the click that would create focus is itself
 * fenced by the absence of focus. That is the fence failing closed on an honest ignorance of
 * where input would land, which is what it is for — it must not be "fixed" by assuming the
 * frontmost window will receive the keystroke. The `browser` tool is the way to drive a web
 * page; it speaks CDP and needs none of this.
 */
private func inputTargetMatches(_ row: WindowRow) -> Bool {
    guard frontmostPID() == row.pid else { return false }
    let rows = allWindowRows(includeMinimized: false)
    // One read, two uses — as in foregroundWindowID, and here it matters more. This is the
    // fence physical input passes through, so a disagreement between two reads of the same
    // fact refuses a legitimate action: QA hit FOCUS_FAILED against a window that was visibly
    // active, because focusWindow polls this and could never satisfy a condition that was
    // partly a race. Every clause still has to hold; they just judge one observation.
    let focused = focusedAXWindowID(for: row.pid, rows: rows)
    guard frontWindowID(rows: rows, focusedWindow: focused) == row.id else { return false }
    guard focused == row.id else { return false }
    // Missing focused-control evidence is not agreement. AX can return nil on a timeout,
    // an untyped value or an app transition; accepting that would turn an unprovable
    // keyboard destination into global physical input.
    guard focusedAXElementWindowID(for: row.pid, rows: rows) == row.id else { return false }
    return true
}

/**
 * Which clause of the input fence refuses this window, for the error message only.
 *
 * `inputTargetMatches` above stays the authority and is deliberately left exactly as it is: it is
 * the fence physical input passes through, and its shape is asserted clause by clause elsewhere.
 * This re-reads the same three facts a moment later purely to say which one disagreed.
 *
 * It earns its keep because "the requested window could not be activated" is a sentence with no
 * next step in it. QA hit it against a Chrome window that was plainly on screen, and answering
 * why took a separate instrumented build on the machine that could reproduce it — for a fact the
 * helper already knew and threw away. Being a second observation it can name a reason that has
 * since changed; a diagnostic that is occasionally stale is still worth more than none.
 */
private func inputTargetRefusal(_ row: WindowRow) -> String {
    guard frontmostPID() == row.pid else { return "another application is frontmost" }
    let rows = allWindowRows(includeMinimized: false)
    let focused = focusedAXWindowID(for: row.pid, rows: rows)
    if let front = frontWindowID(rows: rows, focusedWindow: focused), front != row.id {
        // Naming it is the whole value. A measurement on a Mac found this reason appearing only
        // for Chrome's transient omnibox container — a second window the application opens on
        // Cmd+L, which `windows` lists like any other and which a caller can easily address by
        // mistake. Told only that "another window is in front", there is nothing to do about it;
        // told which one, the caller can target that window or dismiss it.
        return "another window of the same application is in front (window \(front))"
    }
    if focused != row.id {
        return "the application's focused window is \(windowIDDescription(focused))"
    }
    let element = focusedAXElementWindowID(for: row.pid, rows: rows)
    if element != row.id {
        return "the focused control belongs to \(windowIDDescription(element))"
    }
    return "focus moved while the window was being checked"
}

private func windowIDDescription(_ id: CGWindowID?) -> String {
    guard let id else { return "no window this scan can attribute" }
    return "window \(id)"
}

/**
 * A leased window has to contain the point, or the lease meant nothing.
 *
 * `assertInputTarget` proves which window keyboard input reaches. It says nothing about where a
 * pointer event lands, and nothing did: QA leased a window, asked for a click at 5,5 — a corner of
 * the desktop outside every window — and the click was sent, with `Done 1/1`. The fence proved the
 * wrong fact, and the caller was told the right one had been proved.
 *
 * Clicking already requires a lease, so input in this helper always belongs to a window by
 * construction. Requiring the point to be in that window is the other half of the same rule.
 *
 * One pixel of slack on each edge, because a window's own border is part of it and a coordinate
 * read off a screenshot can land exactly on it.
 */
private func requirePointInWindow(_ point: CGPoint, _ row: WindowRow, _ what: String) throws {
    guard row.bounds.insetBy(dx: -1, dy: -1).contains(point) else {
        throw fail(
            "OUTSIDE_TARGET_WINDOW",
            "\(what) at \(Int(point.x)),\(Int(point.y)) is outside window \(row.id), which this " +
                "batch is leased to (\(Int(row.bounds.minX)),\(Int(row.bounds.minY)) " +
                "\(Int(row.bounds.width))x\(Int(row.bounds.height))). No input was sent. Lease the " +
                "window you meant, or take a screenshot of it and use coordinates from that image."
        )
    }
}

private func assertInputTarget(_ id: CGWindowID) throws -> WindowRow {
    guard let row = windowRow(id), row.onScreen else {
        throw fail("INPUT_TARGET_LOST", "target window \(id) no longer exists on screen; no input was sent")
    }
    guard inputTargetMatches(row) else {
        throw fail(
            "INPUT_TARGET_LOST",
            "window \(id) is no longer the exact active input target (\(inputTargetRefusal(row))); no input was sent"
        )
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
        guard axWindowNumber(window) == row.id else { continue }
        // An id match is normally conclusive, and geometry is the second opinion when it is not.
        //
        // This was written on a wrong diagnosis and is kept on a right one. The report it came
        // from said Chrome hands the transient panel over its omnibox the same AXWindowNumber as
        // the window beneath, so asking about the panel returned the main window's tree. The
        // author of that report then measured again and corrected themselves: the panel has its
        // own accessibility window, and the wrong answer came from the request naming the window
        // under a key the helper ignores — refused now, at the top of `handle`.
        //
        // What remains true without that story: an accessibility window carrying this row's id
        // while describing a rectangle nothing like it is not this row's window, and returning
        // its tree would be answering about something else.
        //
        // On macOS 27 this branch is unreachable, and that is measured rather than assumed:
        // `AXWindowNumber` is not an offered attribute there at all — it is absent from the 28 a
        // Chrome window carries, and reading it directly returns kAXErrorAttributeUnsupported
        // (-25205). Across 26 windows of 11 processes, not one matched by id; every match went
        // through geometry. The guard stays for whatever version or application does offer the
        // attribute, but nothing here can exercise it, and the cost of it never firing is the
        // ambiguity handled below.
        guard let bounds = axBounds(window), !convincinglyMatchesWindow(bounds, row.bounds) else {
            return window
        }
        throw fail(
            "UIA_NO_OWN_WINDOW",
            "window \(row.id) has no accessibility window of its own — the one carrying its id " +
                "describes a different window (\(Int(bounds.width))x\(Int(bounds.height)) against " +
                "\(Int(row.bounds.width))x\(Int(row.bounds.height))). Transient panels an " +
                "application draws over its own window behave this way; ask about the window " +
                "underneath instead."
        )
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
        /*
         * Geometry is the fallback, and a window in motion has none that agrees.
         *
         * The row was scanned a moment ago and the accessibility bounds are being read now; a
         * window dragged between the two matches nothing, because the two rectangles describe it
         * at different instants. QA reached this by capturing a window while moving it and got
         * "no accessibility window convincingly matches", which reads as a window that has no
         * accessibility representation at all — and sends someone to check a permission that was
         * never the problem.
         *
         * So look again with the bounds it has now. A window that has come to rest matches on the
         * second read and the caller never learns there was a race. One still moving is told
         * that, which is a different instruction from the one above and the only actionable one.
         */
        if let fresh = windowRow(row.id), fresh.bounds != row.bounds {
            for window in windows {
                guard ProcessInfo.processInfo.systemUptime < deadline else {
                    throw fail("UIA_TIMEOUT", "accessibility window matching exceeded its bounded native deadline")
                }
                guard let bounds = axBounds(window), convincinglyMatchesWindow(bounds, fresh.bounds) else { continue }
                return window
            }
            throw fail(
                "WINDOW_MOVING",
                "window \(row.id) moved while its accessibility tree was being read — from " +
                    "\(Int(row.bounds.minX)),\(Int(row.bounds.minY)) to " +
                    "\(Int(fresh.bounds.minX)),\(Int(fresh.bounds.minY)). Nothing was read. Let it " +
                    "come to rest and ask again."
            )
        }
        throw fail("UIA_FAILED", "no accessibility window convincingly matches window \(row.id)")
    }
    if geometryCandidates.count > 1, geometryCandidates[1].distance - winner.distance < 32 {
        /*
         * Geometry alone cannot separate two windows of one application at the same place, and on
         * macOS 27 geometry is all there is: `AXWindowNumber` is not merely nil there, it is not an
         * offered attribute at all — reading it returns kAXErrorAttributeUnsupported (-25205), and a
         * measurement across 26 windows of 11 processes matched exactly none of them by id. So the
         * exact branch above never runs, and two Finder windows of identical size at identical
         * coordinates made a QA run's drag impossible until a window was moved by hand.
         *
         * The title is already in the row and was going unused. It does not always separate them —
         * one of the pairs on that desktop shared its title too — but when it does, it costs one
         * attribute read and turns an impossible request into an ordinary one.
         */
        let titled = geometryCandidates.filter {
            titlesAgree(axString($0.element, kAXTitleAttribute as CFString), row.title)
        }
        if titled.count == 1 { return titled[0].element }
        // Still ambiguous. Name the candidates: "ambiguous" with nothing else leaves the caller
        // with no move to make, and the one move that works — close or move one of them — needs
        // to know which ones they are.
        let described = geometryCandidates.prefix(4).map { candidate -> String in
            let title = axString(candidate.element, kAXTitleAttribute as CFString) ?? ""
            let bounds = axBounds(candidate.element)
            let size = bounds.map { "\(Int($0.width))x\(Int($0.height)) at \(Int($0.minX)),\(Int($0.minY))" } ?? "no bounds"
            return title.isEmpty ? "an untitled window \(size)" : "\"\(title)\" \(size)"
        }.joined(separator: "; ")
        throw fail(
            // Its own code, because the caller's next move differs. `UIA_FAILED` also means "there
            // is no accessibility window here at all", and a QA run measured `focusable` reporting
            // a save dialog with no accessibility representation as "ambiguous" — telling someone to
            // move one of two windows when there was only ever one.
            "UIA_AMBIGUOUS_WINDOW",
            "window \(row.id) cannot be told apart from another window of the same application: " +
                "\(described). Nothing was done. Nothing here can address them apart either — a focus " +
                "would meet the same ambiguity — so move or close one of them from the application " +
                "itself, then ask again."
        )
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

/// One helper serves every chat, so this cap is shared across a whole swarm: with sixteen,
/// thirteen workers taking turns evicted each other's newest snapshot before its owner could
/// act on a ref from it — forty `STALE_UI_SNAPSHOT` refusals in one run on 2026-09-01. The
/// Windows helper was raised to 96 for that measured failure the same day; this side kept the
/// sixteen that was measured as broken, which is a difference in the number and not in the
/// reasoning. A snapshot holds AX element handles, not screenshots, so keeping a few per
/// worker is cheap.
private let maxUISnapshots = 96

private func rememberSnapshot(window: CGWindowID, windowBounds: CGRect, elements: [String: AXUIElement]) -> Int {
    let id = nextSnapshotID
    nextSnapshotID += 1
    snapshots[id] = UISnapshot(window: window, windowBounds: windowBounds, elements: elements)
    snapshotOrder.append(id)
    while snapshotOrder.count > maxUISnapshots {
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
        throw fail("WINDOW_NOT_FOUND", "no window is in the foreground to read")
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
    // Buttons 3 and 4 are the conventional back/forward side buttons. AppKit and every
    // browser read them from the button number on an other-mouse event, so they are posted
    // exactly like the middle button with a different number — not as synthetic shortcuts,
    // which would go to whatever happens to be focused rather than to the pointer's window.
    case "back": return CGMouseButton(rawValue: 3) ?? .center
    case "forward": return CGMouseButton(rawValue: 4) ?? .center
    default: return .left
    }
}

private func mouseTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    switch button {
    case .left: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    // The middle button and both side buttons are all other-mouse events, told apart only
    // by the button number carried on the event itself.
    default: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    }
}

private func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw fail("INPUT_FAILED", "could not create a mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

/**
 * Moves the pointer, and — when asked — checks that it went.
 *
 * Posting is not moving. A run asked for a move using coordinates read off a frame that had since
 * gone stale, was told `Done 1/1 via sendinput: move`, and the pointer had not left where it
 * started; the same move through a fresh frame worked. The answer described the event rather than
 * the desktop, which is the failure this whole layer exists to avoid.
 *
 * Only the explicit `move` action verifies. A drag is a hundred interpolated steps of a pixel or
 * two, and reading the position back after each would cost more than it proves — the drag already
 * judges itself by what it moved.
 */
private func movePointer(_ point: CGPoint, verify: Bool = false) throws {
    try requirePointOnActiveDisplay(point)
    let before = CGEvent(source: nil)?.location ?? .zero
    try postMouse(.mouseMoved, point: point, button: .left)
    // A move to where the pointer already is has nothing to prove.
    guard verify, hypot(point.x - before.x, point.y - before.y) > 1 else { return }
    let deadline = ProcessInfo.processInfo.systemUptime + 0.25
    while ProcessInfo.processInfo.systemUptime < deadline {
        let now = CGEvent(source: nil)?.location ?? .zero
        if hypot(point.x - now.x, point.y - now.y) <= 2 { return }
        usleep(5_000)
    }
    let ended = CGEvent(source: nil)?.location ?? .zero
    throw fail(
        "POINTER_DID_NOT_MOVE",
        "asked for \(Int(point.x)),\(Int(point.y)); the pointer is at \(Int(ended.x)),\(Int(ended.y)) " +
            "and did not move. Nothing else in this batch ran. Take a fresh screenshot and use " +
            "coordinates from it — a frame from earlier can describe a desktop that has changed."
    )
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
    targetWindow: CGWindowID? = nil,
    expectedDisplays: [CGRect]? = nil
) throws {
    guard xs.count == ys.count, xs.count >= 2 else { throw fail("BAD_ACTION", "drag needs at least two points") }
    let points = zip(xs, ys).map { CGPoint(x: $0.0.doubleValue, y: $0.1.doubleValue) }

    // Window identity and screen topology are independent leases. A screen-bound frame can
    // still carry an explicit targetWindow, so never choose one fence at the expense of the
    // other: re-prove every supplied authority before every physical drag event.
    let displays: [CGRect]
    if let expectedDisplays {
        let currentDisplays = try activeDisplayRects()
        guard sameDisplayTopology(expectedDisplays, currentDisplays) else {
            throw fail("STALE_FRAME", "active display topology changed before the drag")
        }
        displays = expectedDisplays
    } else {
        displays = try activeDisplayRects()
    }
    for point in points { try requirePointOnActiveDisplay(point, displays: displays) }

    func assertDragTarget() throws {
        if let targetWindow { _ = try assertInputTarget(targetWindow) }
        if let expectedDisplays {
            let currentDisplays = try activeDisplayRects()
            guard sameDisplayTopology(expectedDisplays, currentDisplays) else {
                throw fail("STALE_FRAME", "active display topology changed during the drag")
            }
        }
    }

    let (down, up, dragged) = mouseTypes(button)
    try assertDragTarget()
    try postMouse(down, point: points[0], button: button)
    var current = points[0]
    do {
        // Hold before moving. AppKit decides whether a press begins a drag session or is just a
        // click, and a press followed immediately by movement reads as the latter. QA dragged a
        // file in Finder three times, was told "Done" three times, and the file never moved.
        usleep(dragPressHoldMicroseconds)

        // Interpolate. The caller gives waypoints, not a trajectory, and two of them are a
        // teleport: nothing crosses the drag threshold, so no drag session ever starts and no
        // destination is ever hovered. Real pointers move continuously, and the machinery that
        // decides what a drag means is watching for exactly that.
        //
        // The budget is for the whole path, not per hop. Per hop, a 64-waypoint drag — which the
        // schema permits — could post 15,000 events and spend two minutes inside a 15-second
        // parent deadline, and being killed there leaves the button logically held down: the
        // catch below that releases it never runs, because the process is gone. Sized for the
        // whole path, a drag costs the same bounded time however many waypoints it names.
        let stepsPerSegment = dragStepBudget(points)
        for (index, point) in points.dropFirst().enumerated() {
            for step in dragSteps(from: current, to: point, steps: stepsPerSegment[index]) {
                try assertDragTarget()
                try postMouse(dragged, point: step, button: button)
                usleep(dragStepMicroseconds)
            }
            current = point
        }

        // Dwell on the destination before releasing, so whatever is under the pointer has a
        // chance to register the hover and accept the drop.
        try assertDragTarget()
        try postMouse(dragged, point: points[points.count - 1], button: button)
        usleep(dragDropDwellMicroseconds)

        try assertDragTarget()
        try postMouse(up, point: points[points.count - 1], button: button)
    } catch {
        // A best-effort mouse-up is cleanup, not authorization to continue the drag.
        try? postMouse(up, point: current, button: button)
        throw error
    }
}

/**
 * How a drag is paced, in microseconds.
 *
 * Measured, not assumed. An ablation in Finder — one variable changed per run, three runs each —
 * says only one of these is load-bearing:
 *
 *     control                       3/3 moved
 *     no press hold                 3/3 moved
 *     no drop dwell                 3/3 moved
 *     no interpolation              0/3 moved
 *     interpolation only            3/3 moved
 *
 * Interpolation is necessary and, for Finder, sufficient: two waypoints are a teleport, nothing
 * crosses the drag threshold, and no drag session begins. The hold and the dwell are kept
 * anyway — they cost 230ms and the measurement covers one application, while a press that
 * settles and a destination that is hovered is what every other one is documented to want. They
 * are insurance, and the comment should not pretend they were proven.
 *
 * Two things the same run established about judging a drag: the helper answers ok whether or not
 * anything moved, so the return value is not evidence; and the filesystem takes 0-11ms to show
 * the move, so a check with no settle produces false negatives.
 */
private let dragPressHoldMicroseconds: UInt32 = 90_000
private let dragStepMicroseconds: UInt32 = 8_000
private let dragDropDwellMicroseconds: UInt32 = 140_000
/** Longest jump between two posted drag events; beyond this the motion stops looking like motion. */
private let dragMaxStepDistance: CGFloat = 8
/**
 * Most move events one drag may post, whatever its shape.
 *
 * At dragStepMicroseconds each, this bounds the moving part of any drag to about 1.4 seconds —
 * comfortably inside the parent's deadline for a whole batch of actions, which is the thing that
 * must never be exceeded: the parent kills the helper on timeout, and a killed helper never runs
 * the release that would let go of the button.
 */
private let dragMaxTotalSteps = 180

/**
 * How many events each hop of the path gets, sharing one budget for the whole journey.
 *
 * Longer paths take longer strides rather than more time. A drag is not made more convincing by
 * being slower, and a budget spent per hop is not a budget.
 */
private func dragStepBudget(_ points: [CGPoint]) -> [Int] {
    let hops = zip(points, points.dropFirst()).map { start, end -> CGFloat in
        let dx = end.x - start.x
        let dy = end.y - start.y
        return (dx * dx + dy * dy).squareRoot()
    }
    let total = hops.reduce(0, +)
    let wanted = hops.map { max(1, Int(($0 / dragMaxStepDistance).rounded(.up))) }
    let wantedTotal = wanted.reduce(0, +)
    guard wantedTotal > dragMaxTotalSteps, total > 0 else { return wanted }
    // Over budget: give each hop its share of the cap, and never fewer than one event, so a
    // short hop in a long path still happens.
    return hops.map { max(1, Int((CGFloat(dragMaxTotalSteps) * $0 / total).rounded())) }
}

/** The points to post between two waypoints so the pointer travels rather than teleports. */
private func dragSteps(from start: CGPoint, to end: CGPoint, steps: Int) -> [CGPoint] {
    let dx = end.x - start.x
    let dy = end.y - start.y
    let count = max(1, steps)
    return (1...count).map { index in
        let progress = CGFloat(index) / CGFloat(count)
        return CGPoint(x: start.x + dx * progress, y: start.y + dy * progress)
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
    case "cmd", "meta", "super", "win": return "command"
    case "alt": return "option"
    case "ctrl": return "control"
    case "esc": return "escape"
    // The DOM names for the arrow keys. A model that has learned browser key vocabulary
    // emits these, and refusing them for the sake of four shorter synonyms is a needless
    // BAD_KEY on the single most common navigation keys there are.
    case "arrowleft": return "left"
    case "arrowright": return "right"
    case "arrowup": return "up"
    case "arrowdown": return "down"
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

/** The active layout, copied out of the input source so it can be used off the main queue. */
private struct KeyboardLayoutSnapshot {
    let data: Data
    let kbdType: UInt32
}

/** Carries a main-queue result back to the requesting thread. */
private final class MainQueueBox<Value> {
    var value: Value?
}

/** How long a request will wait for the main queue before refusing rather than hanging. */
private let mainQueueTimeout: TimeInterval = 2.0

/**
 * Runs a main-queue-affine platform call and returns its result, or nil if the main queue
 * could not service it in time.
 *
 * AppKit, HIToolbox and Text Services all assert on the main queue, and a violation is not an
 * error return: `dispatch_assert_queue` fails and raises EXC_BREAKPOINT, taking the whole host
 * process down below anything Swift or JS above it can catch. Node enters this addon on a
 * worker thread, so the hop belongs at this boundary rather than in every caller.
 *
 * Deliberately not `DispatchQueue.main.sync`: that deadlocks when this already is the main
 * thread, and waits forever when the main thread is busy, trading a crash for a hang. Running
 * inline covers the first; the bounded wait covers the second by surfacing an ordinary refusal.
 */
private func onMainQueue<Value>(_ work: @escaping () -> Value?) -> Value? {
    if Thread.isMainThread { return work() }
    let box = MainQueueBox<Value>()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
        box.value = work()
        done.signal()
    }
    guard done.wait(timeout: .now() + mainQueueTimeout) == .success else { return nil }
    return box.value
}

/**
 * Reads the active Unicode key layout, on the main queue.
 *
 * Text Services input-source lookups are main-queue-affine. Reached from anywhere else,
 * macOS does not return an error: `dispatch_assert_queue` fails and raises EXC_BREAKPOINT,
 * which takes the whole host process down. Nothing above this — not Swift, not the addon,
 * not any JS layer — can catch that. Node enters this addon on a worker thread, so the hop
 * has to live here; the public entry points stay safe to call from an arbitrary thread.
 *
 * Deliberately not `DispatchQueue.main.sync`: that deadlocks if this is already the main
 * thread, and it waits forever if the main thread is busy or blocked, trading a crash for a
 * hang. Running inline when already on main covers the first, and the bounded wait covers
 * the second by surfacing an ordinary refusal instead.
 *
 * Only the input-source read is marshalled. UCKeyTranslate is a pure function over the
 * layout bytes, so the 128-keycode search stays off the main queue and off the UI thread.
 */
private func currentKeyboardLayout() -> KeyboardLayoutSnapshot? {
    onMainQueue {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return nil }
        guard let rawData = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = unsafeBitCast(rawData, to: CFData.self)
        guard let bytes = CFDataGetBytePtr(data) else { return nil }
        // Copied on purpose: those bytes belong to the input source, which is released as
        // soon as this returns. The keycode search below then reads our own copy, off-main.
        return KeyboardLayoutSnapshot(
            data: Data(bytes: bytes, count: CFDataGetLength(data)),
            kbdType: UInt32(LMGetKbdType())
        )
    }
}

/** The live pointer, as pixels plus the offset from its image origin to the point it addresses. */
private struct PointerImage {
    let image: CGImage
    let hotSpot: CGPoint
    let size: CGSize
}

/**
 * The pointer as it looks right now, read on the main queue because NSCursor is AppKit.
 *
 * Returns nil rather than a stand-in when the system will not describe its cursor: an invented
 * pointer in a screenshot is worse than none, because a coordinate would be read off it.
 */
private func currentPointerImage() -> PointerImage? {
    onMainQueue {
        guard let cursor = NSCursor.currentSystem else { return nil }
        let image = cursor.image
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        var rect = CGRect(origin: .zero, size: image.size)
        guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        return PointerImage(image: cgImage, hotSpot: cursor.hotSpot, size: image.size)
    }
}

/**
 * Draws the pointer into a window capture.
 *
 * `SCStreamConfiguration.showsCursor` is set on every capture in this file, but it can only
 * act where the pointer exists in the captured content — and a desktop-independent window
 * filter captures the window detached from the desktop, while the pointer is a display
 * compositing layer. Display capture gets the pointer from the system; window capture, which
 * is what an ordinary `observe` on a window uses, never could.
 *
 * Drawn at the hotspot, which is the pixel the pointer addresses: an I-beam or a resize arrow
 * is centred, not top-left, and drawing at the image origin would put the tip several pixels
 * off exactly when a coordinate is being read off the picture.
 *
 * Returns why it did nothing when it does nothing. Every reason here is silent in the picture
 * — an absent pointer looks the same whether the system would not describe one, the pointer
 * was outside the window, or the buffer failed — and "no pointer in the screenshot" has
 * already cost one round of guessing at which. The caller puts this in the response.
 */
private func drawingPointer(on image: CGImage, region: CGRect) -> (CGImage, String) {
    guard let pointer = currentPointerImage() else { return (image, "unavailable") }
    let location = CGEvent(source: nil)?.location ?? .zero
    guard region.width > 0, region.height > 0, region.contains(location) else {
        return (image, "outside_region")
    }

    let scale = CGFloat(image.width) / region.width
    let width = pointer.size.width * scale
    let height = pointer.size.height * scale
    // Global screen coordinates run top-down; a bitmap context runs bottom-up.
    let x = (location.x - pointer.hotSpot.x - region.minX) * scale
    let top = (location.y - pointer.hotSpot.y - region.minY) * scale
    let y = CGFloat(image.height) - top - height

    guard let context = CGContext(
        data: nil,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: image.width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return (image, "buffer_unavailable") }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    context.draw(pointer.image, in: CGRect(x: x, y: y, width: width, height: height))
    guard let composited = context.makeImage() else { return (image, "buffer_unavailable") }
    return (composited, "drawn")
}

private func currentLayoutKey(for logicalName: String, in snapshot: KeyboardLayoutSnapshot) -> ResolvedKey? {
    let modifierCandidates: [(carbon: UInt32, event: CGEventFlags)] = [
        (0, []),
        (UInt32(shiftKey >> 8), .maskShift),
        (UInt32(optionKey >> 8), .maskAlternate),
        (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate])
    ]

    return snapshot.data.withUnsafeBytes { raw -> ResolvedKey? in
        guard let base = raw.baseAddress else { return nil }
        let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
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
                        snapshot.kbdType,
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
}

private func resolveKey(_ name: String, in snapshot: KeyboardLayoutSnapshot?) throws -> ResolvedKey {
    if name.count == 1 {
        guard let snapshot else {
            throw fail("INPUT_FAILED", "the active keyboard layout could not be read in time")
        }
        guard let resolved = currentLayoutKey(for: name, in: snapshot) else {
            throw fail("BAD_KEY", "active keyboard layout does not expose logical key \(name)")
        }
        return resolved
    }
    // Name what is accepted, not just what was refused. The Windows helper's own BAD_KEY has
    // said this since 2026-09-04; a QA run met the terser macOS wording and had nothing to
    // correct itself from, which is the whole job of this refusal. The list is written from
    // `keyCodes` and `normalizedKeyName` above rather than copied from Windows: this helper
    // takes the macOS modifier names, and forwarddelete/help/volume keys are its own.
    guard let code = keyCodes[name] else {
        throw fail(
            "BAD_KEY",
            "unknown key \(name). Use one character, or a key name: return, enter, tab, space, "
                + "escape, backspace, delete, forwarddelete, home, end, pageup, pagedown, up, down, "
                + "left, right, f1-f20, help, volumeup, volumedown, mute, capslock, or a modifier "
                + "command, option, control, shift"
        )
    }
    return ResolvedKey(code: code, requiredFlags: [])
}

private func pressKeys(_ names: [String], targetWindow: CGWindowID? = nil) throws {
    let normalized = names.map(normalizedKeyName)
    // One snapshot for the whole chord, taken before any window authority is resolved: every
    // key resolves against the same input source, and the main queue is entered at most once
    // per request. Named keys never need it, so an ordinary shortcut does not hop at all.
    let layout = normalized.contains { $0.count == 1 } ? currentKeyboardLayout() : nil
    let resolved = try normalized.map { try resolveKey($0, in: layout) }
    let globalShortcut = isSystemShortcut(normalized)
    guard targetWindow != nil || globalShortcut else {
        throw fail("INPUT_TARGET_REQUIRED", "application keyboard input requires targetWindow")
    }
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

/**
 * Types text, sending newlines as the Return key rather than as text.
 *
 * A newline inside a unicode string is where this used to lose whole sentences. The text was cut
 * into chunks of at most 32 UTF-16 units and each chunk handed to `keyboardSetUnicodeString`; when
 * a chunk happened to *begin* with U+000A, macOS delivered the newline — late, on the next event —
 * and discarded the rest of that chunk. Up to 31 characters vanished, and the helper answered
 * `ok: true` with `routes: ["sendinput"]`.
 *
 * That made it depend on the offset rather than on the text: the same words arrived or did not
 * according to where a newline happened to land relative to a multiple of 32. It was found by
 * prediction — cut the same sentence at index 32 and at index 20, and only the first loses its
 * tail — which is why it survived so long: retrying the same string reproduces nothing.
 *
 * A newline is a keystroke, not a character, and sending it as one is also what a real keyboard
 * does. Editors that treat Return specially — a search field that submits, a chat box that sends —
 * now see what they expect instead of a control character in a paste.
 */
private func typeText(_ text: String, targetWindow: CGWindowID? = nil) throws {
    guard let source = CGEventSource(stateID: .privateState) else {
        throw fail("INPUT_FAILED", "could not create a keyboard event source")
    }

    func deliver(_ event: CGEvent) throws {
        if let targetWindow {
            let target = try assertInputTarget(targetWindow)
            event.postToPid(target.pid)
        } else {
            event.post(tap: .cghidEventTap)
        }
    }

    func sendRun(_ units: [UInt16]) throws {
        var cursor = 0
        while cursor < units.count {
            var end = min(units.count, cursor + 32)
            // Never split a surrogate pair across two events: half of one is not a character.
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
            try deliver(down)
            try deliver(up)
            cursor = end
        }
    }

    func sendReturn() throws {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) else {
            throw fail("INPUT_FAILED", "could not create a newline event")
        }
        try deliver(down)
        try deliver(up)
    }

    // Every line ending becomes the same thing, so a document written on one platform types the
    // same as one written on another.
    let normalized = text
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
    let runs = normalized.components(separatedBy: "\n")
    for (index, run) in runs.enumerated() {
        if index > 0 { try sendReturn() }
        let units = Array(run.utf16)
        if !units.isEmpty { try sendRun(units) }
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
    let action = string(request["action"])
    // What a control says about itself decides; silence defers to what it can do.
    //
    // An explicit AXEnabled=false always refuses: a control that says it is disabled is
    // disabled, whatever else it reports. Absent, untyped or timed-out AXEnabled is not a
    // refusal though — some genuinely interactive controls publish no such attribute at all,
    // and TextEdit's document AXTextArea is one of them. For those, accessibility offers a
    // second and more direct authority: whether AXValue can be written. A control whose value
    // can be set is interactive by definition.
    //
    // That fallback was first allowed only for set_value, on the reasoning that silence should
    // not license a click. QA then found the other half of the same defect: click_ref against
    // that same editable TextArea was refused as disabled while a coordinate click focused it,
    // typing worked, and set_value worked. Refusing there blocked legitimate ref-first work on
    // a control already proven interactive by the very evidence being ignored. Silence alone
    // still refuses — a control with no AXEnabled and no settable value gets nothing.
    let enabled = axOptionalBool(element, kAXEnabledAttribute as CFString)
    let permitted = enabled ?? axValueIsSettable(element)
    guard permitted else {
        throw fail("UI_ACTION_DISABLED", "the referenced accessibility control is disabled")
    }
    var route = "uia"
    // Whether the control's own reported value actually moved, for the click branch only —
    // nil where there is nothing comparable to say (an ordinary button, say), which is a
    // different fact from "unchanged" and must not be reported as one.
    var changed: Bool?
    if action == "set_value" {
        guard axValueIsSettable(element),
              AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, string(request["value"]) as CFTypeRef) == .success else {
            throw fail("UI_ACTION_FAILED", "the control does not expose a settable value")
        }
    } else if action == "click" {
        let beforeValue = axComparableValue(element)
        if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
            guard try focusWindow(snapshot.window) else {
                let why = windowRow(snapshot.window).map(inputTargetRefusal) ?? "the window is gone"
                throw fail("FOCUS_FAILED", "snapshot window \(snapshot.window) could not be activated: \(why)")
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
        } else {
            /*
             * `AXUIElementPerformAction` returning `.success` is the protocol saying the message
             * was accepted, not that anything happened. QA measured the gap directly: pressing a
             * System Settings toggle through AXPress returned success and the switch stayed
             * exactly where it was; a coordinate click on the same spot moved it. This is the
             * same shape as the scroll gesture that used to be judged by acknowledgement instead
             * of by whether the page moved — so, the same fix: compare the control's own value
             * before and after, and say so, rather than trust the API's verdict about itself.
             */
            let afterValue = axComparableValue(element)
            if let beforeValue, let afterValue {
                changed = !beforeValue.isEqual(afterValue)
            }
        }
    } else {
        throw fail("BAD_ACTION", "unknown UI action \(action)")
    }
    var result: JSONObject = ["runtimeKey": runtimeKey, "name": axName(element), "route": route]
    if let changed { result["changed"] = changed }
    return result
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
        guard let after = windowRow(windowID), after.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) changed geometry during frame validation")
        }
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
) throws -> (CGImage, CGRect, String) {
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
    let resized = try resizedImage(image, width: width, height: height)
    // showsCursor above cannot reach a desktop-independent filter, so the pointer is drawn
    // here. Display capture keeps the system's own, which is why this is only done for windows.
    let (drawn, pointerNote) = drawingPointer(on: resized, region: region)
    return (drawn, region, pointerNote)
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
    let pointerNote: String
    var capturedWindowGeometry: CGRect?
    if let requestedWindow {
        guard let row = windowRow(requestedWindow) else {
            throw fail("WINDOW_NOT_FOUND", "no window with id \(requestedWindow) is available")
        }
        capturedWindowGeometry = row.bounds
        do {
            (image, region, pointerNote) = try captureWindow(
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
            pointerNote = "system"
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
        pointerNote = "system"
    } else if bool(request["full"]) {
        region = screen
        image = try captureComposite(
            region: region,
            maxWidth: maxWidth,
            displays: content.displays,
            expectedDisplays: displayRects
        )
        captureMode = "screen"
        pointerNote = "system"
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw fail("SCREEN_UNAVAILABLE", "ScreenCaptureKit reported no display")
        }
        (image, region) = try captureDisplay(display, maxWidth: maxWidth)
        captureMode = "screen"
        pointerNote = "system"
    }
    let finalDisplayRects = try activeDisplayRects()
    guard sameDisplayTopology(displayRects, finalDisplayRects) else {
        throw fail("STALE_FRAME", "display topology changed while screenshot was captured")
    }
    guard sameDisplayTopology(displayRects, try activeDisplayRects()) else {
        throw fail("STALE_FRAME", "active display topology changed while screenshot was captured")
    }
    try writePNG(image, path: file)
    var response: JSONObject = [
        "region": rectObject(region),
        "image": ["width": image.width, "height": image.height],
        "screen": rectObject(screen),
        "displays": displayTopologyObject(finalDisplayRects),
        "focused": requestedWindow == nil ? NSNull() : foregroundWindowID() == requestedWindow,
        "captureMode": captureMode,
        "pointer": pointerNote
    ]
    if let capturedWindowGeometry {
        response["windowGeometry"] = rectObject(capturedWindowGeometry)
    }
    return response
}

private func handle(_ request: JSONObject) throws -> JSONObject {
    let operation = string(request["op"])
    /*
     * A window named under the wrong key is refused, not ignored.
     *
     * Every operation here reads `id`. A request carrying `window` instead had that key silently
     * dropped, and the operation then fell back to the foreground window and answered about it
     * with ok: true. A QA run spent a whole round on that: it asked `find_ui` about a small
     * transient panel, got the main window's entire tree back, and reasonably concluded that
     * window matching was broken. It was not — the question had never been asked.
     *
     * The silence costs more than a wrong answer would, because the answer looks right. A caller
     * that clicks the elements it gets back clicks in a window it never named. And there are
     * three ways to name a window across this protocol — `id` here, `window` inside an `act`
     * action, `targetWindow` on an `act` request — so getting it wrong is ordinary rather than
     * careless.
     *
     * `act` is exempt: it legitimately carries `targetWindow`, and its actions carry `window`.
     */
    if operation != "act", request["window"] != nil {
        throw fail(
            "BAD_REQUEST",
            "this request names a window under `window`, but every operation reads it under `id`. " +
                "Nothing was done. Send `id` — `window` belongs on an action inside `act`, and " +
                "`targetWindow` on an `act` request."
        )
    }
    /*
     * An `act` request naming a key this protocol does not have is refused, not ignored.
     *
     * `window` above was fixed as its own case because a QA run happened to send that one key.
     * The rule it revealed is general — an unrecognized field is silently dropped and the call
     * still answers `ok: true` — and applying it to one key instead of as a rule meant the next
     * one, whatever its name, would cost the same round again. It did: a later run sent
     * `verification` (a real field, but one this helper has never implemented — that contract
     * lives in the app layer, which turns it into ordinary `id`/`find_ui` calls before any of
     * this runs) and a nonsense key, and both were accepted and quietly did nothing. A caller
     * who believes an unreachable verification ran, because the call it made for it said `ok`,
     * is worse off than one who is told plainly that it did not.
     */
    if operation == "act" {
        let knownActKeys: Set<String> = ["op", "frame", "targetWindow", "actions"]
        if let strayKey = request.keys.first(where: { !knownActKeys.contains($0) }) {
            throw fail(
                "BAD_REQUEST",
                "act does not recognize `\(strayKey)`. It reads `frame`, `targetWindow` and " +
                    "`actions` only. Nothing was done."
            )
        }
    }
    /*
     * The same rule, on the three operations simple enough to enumerate without re-auditing
     * every field the richer operations read.
     *
     * `act`'s stray-key check above was itself the second fix for this exact shape — `window`
     * was fixed as its own case first — and a QA round measured that the rule still had not
     * reached anywhere else: `windows`, `warm` and `cursor` took any key at all and silently
     * did nothing with it, answering `ok: true` for a field that was never read. `warm` and
     * `cursor` read nothing but `op`; `windows` reads one optional field besides it. Both are
     * short enough lists to check safely here; `find_ui`, `act_ui`, `capture` and `snapshot`
     * read enough fields, some of them forwarded between each other, that enumerating them
     * belongs in its own change rather than being guessed at alongside this one.
     */
    if operation == "warm" || operation == "cursor" {
        if let strayKey = request.keys.first(where: { $0 != "op" }) {
            throw fail(
                "BAD_REQUEST",
                "\(operation) does not recognize `\(strayKey)`. It takes no fields beyond `op`. Nothing was done."
            )
        }
    }
    if operation == "windows" {
        let knownWindowsKeys: Set<String> = ["op", "focusable"]
        if let strayKey = request.keys.first(where: { !knownWindowsKeys.contains($0) }) {
            throw fail(
                "BAD_REQUEST",
                "windows does not recognize `\(strayKey)`. It reads `focusable` only, besides `op`. Nothing was done."
            )
        }
    }
    var result: JSONObject = ["ok": true]
    switch operation {
    case "warm":
        result["ready"] = true
        result["screenPermission"] = CGPreflightScreenCaptureAccess()
        result["accessibilityPermission"] = AXIsProcessTrusted()
    case "cursor":
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
        // Whether the application in front is this one. Its windows are deliberately excluded
        // from enumeration — the model must not drive the app driving it — but that made a
        // correct refusal look like a wrong answer: QA saw `No foreground window` while Chat On
        // Steroids was plainly frontmost. Reported so the caller can say which it is.
        result["foregroundIsSelf"] = frontmostPID() == getpid()
    case "windows":
        let foreground = foregroundWindowID()
        let rows = allWindowRows()
        /*
         * `focusable` is asked for, never given away.
         *
         * A transient panel an application draws over its own window — Chrome's omnibox container
         * is the one everybody meets — is listed like any other window and reads like any other
         * window, and the only thing that sets it apart is that it refuses to come to the front
         * while its parent is there. Its size and its title cannot be used for that: real tool
         * windows and inspectors are small and generically titled too.
         *
         * What does say it is whether `AXMain` can be set. Measured on macOS 27: false for the
         * container, true for an ordinary window, both with a clean API result — and the reading
         * itself costs about 0.05 ms, under 2 ms for a list of 26. But reaching the element to ask
         * costs 112–117 ms for that same list, one round trip into every other application, and
         * this call is made constantly. Paying that on every list to carry a field that says
         * `true` for nearly every window in it is the wrong trade, so it is here and it is opt-in.
         */
        if request["focusable"] as? Bool == true {
            result["windows"] = rows.map { row -> JSONObject in
                var entry = row.json(foreground: foreground)
                do {
                    let window = try matchingAXWindow(row)
                    var settable = DarwinBoolean(false)
                    let status = AXUIElementIsAttributeSettable(window, kAXMainAttribute as CFString, &settable)
                    // A window whose answer cannot be read is reported focusable: refusing to
                    // drive something on a failed reading would be worse than the reading's absence.
                    entry["focusable"] = status == .success ? settable.boolValue : true
                } catch {
                    /*
                     * `null` alone was two different answers wearing one hat. It was documented as
                     * "no element to ask", but a `try?` was also swallowing the named refusal for
                     * windows this scan cannot tell apart — and those two call for opposite things
                     * from the caller. Nothing can be done about an application that exposes no
                     * accessibility window; moving or closing one of three identical windows takes
                     * a moment. So the reason rides alongside, and only when there is one.
                     */
                    entry["focusable"] = NSNull()
                    entry["focusableUnknown"] =
                        (error as? HelperFailure)?.code == "UIA_AMBIGUOUS_WINDOW" ? "ambiguous" : "unavailable"
                }
                return entry
            }
        } else {
            result["windows"] = rows.map { $0.json(foreground: foreground) }
        }
        result["screen"] = rectObject(try virtualScreenRect())
    case "active":
        result["foregroundIsSelf"] = frontmostPID() == getpid()
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
        let requested = number(request["id"])?.uint32Value
        let id = requested ?? foregroundWindowID()
        guard let id, let row = windowRow(id) else {
            // Name the window that is gone. "No matching visible window" describes the desktop
            // rather than the request, and a caller that asked for one window in particular is
            // left to guess whether it closed, was never valid, or the whole desktop is empty.
            throw fail(
                "WINDOW_NOT_FOUND",
                requested.map { "window \($0) is no longer on screen" }
                    ?? "no window is in the foreground to snapshot"
            )
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
            } catch let error as HelperFailure where onlyTheTreeFailed(error.code) {
                // Screen capture is an independent capability. If only the AX tree is
                // unavailable/malformed/slow, keep the already-valid image and report typed
                // semantic unavailability. Target-identity failures remain fatal.
                result["uiUnavailable"] = ["code": error.code, "message": error.message]
            }
        }
    case "act":
        try requireAccessibility()
        let frame = request["frame"] as? JSONObject
        if let frame { try validateFrame(frame) }
        let frameWindow = number(frame?["window"])?.uint32Value
        let requestedTargetWindow = number(request["targetWindow"])?.uint32Value
        if let frameWindow, let requestedTargetWindow, frameWindow != requestedTargetWindow {
            throw fail(
                "TARGET_WINDOW_CONFLICT",
                "frame targets window \(frameWindow), but targetWindow is \(requestedTargetWindow)"
            )
        }
        var leasedWindow = frameWindow ?? requestedTargetWindow
        let actions = request["actions"] as? [JSONObject] ?? []
        var routes: [String] = []
        var scrollEvidence: JSONObject?
        // Same evidence-over-acknowledgement shape as scroll's `moved`: whether a `click_ui`'s
        // own AXPress actually changed the control's reported value, not just whether the API
        // call was accepted. Nil when the control had nothing comparable to check.
        var uiChanged: Bool?
        var completed = 0
        for (index, action) in actions.enumerated() {
            do {
                let type = string(action["type"])
                switch type {
                case "click_ui", "set_value_ui":
                    guard let actionWindow = number(action["window"])?.uint32Value else {
                        throw fail("BAD_ACTION", "semantic action is missing its window")
                    }
                    if let leasedWindow, leasedWindow != actionWindow {
                        throw fail(
                            "TARGET_WINDOW_CONFLICT",
                            "semantic action targets window \(actionWindow), but this batch is leased to window \(leasedWindow)"
                        )
                    }
                    leasedWindow = actionWindow
                    var uiRequest = action
                    uiRequest["id"] = action["window"]
                    uiRequest["action"] = type == "click_ui" ? "click" : "set_value"
                    uiRequest["value"] = action["value"]
                    let reply = try actUI(uiRequest)
                    routes.append(string(reply["route"], default: "uia"))
                    if type == "click_ui", let changed = reply["changed"] as? Bool {
                        uiChanged = changed
                    }
                case "move":
                    if let frame { _ = try assertFrameTarget(frame) }
                    try movePointer(CGPoint(x: int(action["x"]), y: int(action["y"])), verify: true)
                    routes.append("sendinput")
                case "click", "double_click":
                    if let frame { _ = try assertFrameTarget(frame) }
                    guard let target = leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "click input requires targetWindow")
                    }
                    let clickRow = try assertInputTarget(target)
                    let clickAt = CGPoint(x: int(action["x"]), y: int(action["y"]))
                    try requirePointInWindow(clickAt, clickRow, type)
                    try click(
                        clickAt,
                        button: mouseButton(string(action["button"])),
                        count: type == "double_click" ? 2 : 1,
                        targetWindow: target
                    )
                    routes.append("sendinput")
                case "scroll":
                    if let frame { _ = try assertFrameTarget(frame) }
                    guard let target = leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "scroll input requires targetWindow")
                    }
                    let scrollRow = try assertInputTarget(target)
                    let scrollAt = CGPoint(x: int(action["x"]), y: int(action["y"]))
                    try requirePointInWindow(scrollAt, scrollRow, "scroll")
                    try movePointer(scrollAt)
                    if let frame { _ = try assertFrameTarget(frame) }
                    _ = try assertInputTarget(target)
                    guard let event = CGEvent(
                        scrollWheelEvent2Source: nil,
                        units: .line,
                        wheelCount: 2,
                        wheel1: Int32(-int(action["scroll_y"])),
                        wheel2: Int32(int(action["scroll_x"])),
                        wheel3: 0
                    ) else { throw fail("INPUT_FAILED", "could not create a scroll event") }
                    let before = pointerScrollState(scrollAt)
                    event.post(tap: .cghidEventTap)
                    let after = settledScrollState(scrollAt, startedAt: before.fraction)
                    var evidence: JSONObject = [
                        "targetPid": Int(scrollRow.pid),
                        "reachedTarget": before.pid == scrollRow.pid
                    ]
                    evidence["hitPid"] = before.pid.map { Int($0) as Any } ?? NSNull()
                    evidence["hitRole"] = before.role.map { $0 as Any } ?? NSNull()
                    if let start = before.fraction, let end = after.fraction {
                        evidence["positionBefore"] = start
                        evidence["positionAfter"] = end
                        evidence["moved"] = abs(end - start) > 0.0001
                    } else {
                        evidence["moved"] = NSNull()
                        evidence["movedUnknown"] = before.pid == nil
                            ? "nothing under the pointer"
                            : "nothing scrollable under the pointer"
                    }
                    scrollEvidence = evidence
                    routes.append("sendinput")
                case "drag":
                    if let frame { _ = try assertFrameTarget(frame) }
                    guard let target = leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "drag input requires targetWindow")
                    }
                    _ = try assertInputTarget(target)
                    try drag(
                        action["xs"] as? [NSNumber] ?? [],
                        action["ys"] as? [NSNumber] ?? [],
                        button: mouseButton(string(action["button"])),
                        targetWindow: target,
                        expectedDisplays: frameWindow == nil ? displayTopology(frame?["displays"]) : nil
                    )
                    routes.append("sendinput")
                case "type":
                    guard let target = leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "text input requires targetWindow")
                    }
                    _ = try assertInputTarget(target)
                    try typeText(string(action["text"]), targetWindow: target)
                    routes.append("sendinput")
                case "keypress":
                    let keys = action["keys"] as? [String] ?? []
                    if let target = leasedWindow {
                        _ = try assertInputTarget(target)
                        try pressKeys(keys, targetWindow: target)
                    } else {
                        // System-owned shortcuts are intentionally global; pressKeys itself
                        // rejects ordinary application keys when no exact window is leased.
                        try pressKeys(keys, targetWindow: nil)
                    }
                    routes.append("sendinput")
                case "focus":
                    let requested = CGWindowID(int(action["window"]))
                    if let leasedWindow, leasedWindow != requested {
                        throw fail(
                            "TARGET_WINDOW_CONFLICT",
                            "focus targets window \(requested), but this batch is leased to window \(leasedWindow)"
                        )
                    }
                    leasedWindow = requested
                    guard try focusWindow(requested) else {
                        let why = windowRow(requested).map(inputTargetRefusal) ?? "the window is gone"
                        throw fail("FOCUS_FAILED", "the requested window could not be activated: \(why)")
                    }
                    routes.append("focus")
                default:
                    throw fail("BAD_ACTION", "unknown action \(type)")
                }
                completed += 1
            } catch let error as HelperFailure {
                // Only when a scroll happened. A `"scroll": null` on every refused keystroke is a
                // field that means nothing about the answer it rides on, and it rode on all of them.
                var failure: JSONObject = [
                    "ok": false,
                    "error_code": error.code,
                    "message": error.message,
                    "completed_count": completed,
                    "failed_index": index,
                    "routes": routes
                ]
                if let scrollEvidence { failure["scroll"] = scrollEvidence }
                if let uiChanged { failure["ui_changed"] = uiChanged }
                return failure
            }
        }
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
        result["completed_count"] = completed
        result["routes"] = routes
        if let scrollEvidence { result["scroll"] = scrollEvidence }
        if let uiChanged { result["ui_changed"] = uiChanged }
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

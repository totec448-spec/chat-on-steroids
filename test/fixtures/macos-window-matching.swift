import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Synthetic AX responses around the real matching and geometry functions.
// No AppKit, permission prompt, focus change or physical input is involved.
private typealias CGWindowID = UInt32
private typealias CFString = String
private struct AXUIElement { let name: String; let id: CGWindowID?; let bounds: CGRect? }
private struct WindowRow { let id: CGWindowID; let pid: Int32; let bounds: CGRect }
private struct ProbeFailure: Error { let code: String }
private let kAXWindowsAttribute = "windows"
private let maxAXTraversalSeconds = 6.0
private var suppliedWindows: [AXUIElement] = []
private func requireAccessibility() throws {}
private func axApplication(_ pid: Int32) -> AXUIElement { AXUIElement(name: "app", id: nil, bounds: nil) }
private func axElementValues(_ app: AXUIElement, attribute: CFString, limit: Int) -> [AXUIElement] {
    Array(suppliedWindows.prefix(limit))
}
private func axWindowNumber(_ window: AXUIElement) -> CGWindowID? { window.id }
private func axBounds(_ window: AXUIElement) -> CGRect? { window.bounds }
private func fail(_ code: String, _ message: String) -> ProbeFailure { ProbeFailure(code: code) }

// PRODUCTION_FUNCTIONS

private let bounds = CGRect(x: 0, y: 0, width: 800, height: 600)
private let target = WindowRow(id: 17, pid: 101, bounds: bounds)
private func check(_ name: String, _ candidates: [AXUIElement], expected: String?) throws {
    suppliedWindows = candidates
    var actual: String? = nil
    do { actual = try matchingAXWindow(target).name }
    catch let error as ProbeFailure where error.code == "UIA_FAILED" {}
    guard actual == expected else { throw ProbeFailure(code: "FAILED: \(name), got \(actual ?? "none")") }
    print("PASS: \(name)")
}
private let exact = AXUIElement(name: "exact", id: 17, bounds: bounds)
private let contrary = AXUIElement(name: "contrary", id: 29, bounds: bounds)
private let unnamed = AXUIElement(name: "unnamed", id: nil, bounds: bounds)
try check("contradictory ID cannot borrow matching geometry", [contrary], expected: nil)
try check("absent ID permits matching geometry", [unnamed], expected: "unnamed")
try check("exact ID wins over other geometry", [contrary, unnamed, exact], expected: "exact")
try check("contrary ID does not make an unnamed match ambiguous", [contrary, unnamed], expected: "unnamed")
try check("two unnamed matches remain ambiguous", [unnamed, AXUIElement(name: "other", id: nil, bounds: bounds)], expected: nil)
try check("unrelated geometry remains rejected", [AXUIElement(name: "far", id: nil, bounds: CGRect(x: 4000, y: 0, width: 800, height: 600))], expected: nil)

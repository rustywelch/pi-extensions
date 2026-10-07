// cu: macOS desktop helper for the pi `computer` tool. Compiled once and cached by computer-use.ts.
// All coordinates are global screen points, origin top-left. Output is plain text or JSON on stdout.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ msg: String) -> Never {
	FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
	exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("usage: cu <command> ...") }

func num(_ i: Int) -> Double {
	guard i < args.count, let v = Double(args[i]) else { fail("argument \(i) must be a number") }
	return v
}

let src = CGEventSource(stateID: .hidSystemState)

func post(_ e: CGEvent?) {
	e?.post(tap: .cghidEventTap)
	usleep(15_000)
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
	let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button)
	e?.setIntegerValueField(.mouseEventClickState, value: clicks)
	post(e)
}

let keyCodes: [String: CGKeyCode] = [
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
	"e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
	"7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
	"'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
	"return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
	"forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
	"left": 123, "right": 124, "down": 125, "up": 126,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
	"f11": 103, "f12": 111,
]

func pressKey(_ combo: String) {
	var flags: CGEventFlags = []
	var key: String? = nil
	for part in combo.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init) {
		switch part {
		case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
		case "ctrl", "control": flags.insert(.maskControl)
		case "alt", "option", "opt": flags.insert(.maskAlternate)
		case "shift": flags.insert(.maskShift)
		case "": key = "+"
		default: key = part
		}
	}
	guard let k = key, let code = keyCodes[k] else { fail("unknown key in combo \(combo)") }
	for down in [true, false] {
		let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
		e?.flags = flags
		post(e)
	}
}

func typeText(_ s: String) {
	for ch in s {
		if ch == "\n" { pressKey("return"); continue }
		if ch == "\t" { pressKey("tab"); continue }
		let u = Array(String(ch).utf16)
		for down in [true, false] {
			let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
			e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
			post(e)
		}
		usleep(8_000)
	}
}

// MARK: accessibility tree

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
	var v: CFTypeRef?
	return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func frame(_ el: AXUIElement) -> CGRect? {
	guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
	var pt = CGPoint.zero
	var sz = CGSize.zero
	AXValueGetValue(p as! AXValue, .cgPoint, &pt)
	AXValueGetValue(s as! AXValue, .cgSize, &sz)
	return CGRect(origin: pt, size: sz)
}

func str(_ v: CFTypeRef?) -> String? {
	if let s = v as? String, !s.isEmpty { return s }
	if let n = v as? NSNumber { return n.stringValue }
	return nil
}

func dumpTree(_ el: AXUIElement, depth: Int, maxDepth: Int, lines: inout [String], limit: Int) {
	if lines.count >= limit || depth > maxDepth { return }
	let role = str(attr(el, kAXRoleAttribute)) ?? "?"
	let title = str(attr(el, kAXTitleAttribute)) ?? str(attr(el, kAXDescriptionAttribute)) ?? str(attr(el, "AXPlaceholderValue"))
	let value = str(attr(el, kAXValueAttribute))
	let help = str(attr(el, kAXHelpAttribute))
	let interesting = title != nil || value != nil || help != nil
	let actionable = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXComboBox", "AXTab", "AXSlider", "AXSwitch"].contains(role)
	if interesting || actionable {
		var bits = [role]
		if let t = title { bits.append("\"\(t.prefix(80))\"") }
		if let v = value, v != title { bits.append("value=\"\(v.prefix(80))\"") }
		if let h = help, h != title { bits.append("help=\"\(h.prefix(60))\"") }
		if let f = frame(el), f.width > 0, f.height > 0 {
			bits.append("center=(\(Int(f.midX)),\(Int(f.midY))) \(Int(f.width))x\(Int(f.height))")
		}
		if let en = attr(el, kAXEnabledAttribute) as? Bool, !en { bits.append("disabled") }
		lines.append(String(repeating: " ", count: min(depth, 12)) + bits.joined(separator: " "))
	}
	guard let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
	for k in kids { dumpTree(k, depth: depth + 1, maxDepth: maxDepth, lines: &lines, limit: limit) }
}

// MARK: commands

switch cmd {
case "trusted":
	let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: args.contains("--prompt")] as CFDictionary
	let ax = AXIsProcessTrustedWithOptions(opts)
	let screen = CGPreflightScreenCaptureAccess()
	print("accessibility=\(ax) screen_recording=\(screen)")

case "windows":
	// Lists on-screen windows front to back: id, pid, owner, bounds, title.
	let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
	var out: [[String: Any]] = []
	for w in list {
		guard (w[kCGWindowLayer as String] as? Int) == 0, let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
		if (b["Width"] ?? 0) < 40 || (b["Height"] ?? 0) < 40 { continue }
		out.append([
			"id": w[kCGWindowNumber as String] ?? 0, "pid": w[kCGWindowOwnerPID as String] ?? 0,
			"app": w[kCGWindowOwnerName as String] ?? "", "title": w[kCGWindowName as String] ?? "",
			"x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0,
		])
	}
	let data = try! JSONSerialization.data(withJSONObject: out)
	print(String(data: data, encoding: .utf8)!)

case "displays":
	let s = NSScreen.main!.frame
	print("\(Int(s.width)) \(Int(s.height)) \(NSScreen.main!.backingScaleFactor)")

case "tree":
	guard args.count >= 2, let pid = Int32(args[1]) else { fail("tree <pid> [maxDepth] [limit]") }
	let maxDepth = args.count > 2 ? Int(args[2]) ?? 14 : 14
	let limit = args.count > 3 ? Int(args[3]) ?? 400 : 400
	let app = AXUIElementCreateApplication(pid)
	var lines: [String] = []
	// Windows first so content is never starved by the menu bar; menus last, top level only.
	for w in attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
		dumpTree(w, depth: 0, maxDepth: maxDepth, lines: &lines, limit: limit)
	}
	if let bar = attr(app, kAXMenuBarAttribute) {
		lines.append("Menu bar:")
		dumpTree(bar as! AXUIElement, depth: 0, maxDepth: 1, lines: &lines, limit: limit + 40)
	}
	if lines.isEmpty { fail("no accessibility elements; grant Accessibility permission or the app exposes none") }
	print(lines.joined(separator: "\n"))
	if lines.count >= limit { print("[truncated at \(limit) elements]") }

case "move":
	mouse(.mouseMoved, CGPoint(x: num(1), y: num(2)))

case "click":
	// click x y [left|right|middle] [count]
	let p = CGPoint(x: num(1), y: num(2))
	let which = args.count > 3 ? args[3] : "left"
	let count = args.count > 4 ? Int64(args[4]) ?? 1 : 1
	let (down, up, button): (CGEventType, CGEventType, CGMouseButton) =
		which == "right" ? (.rightMouseDown, .rightMouseUp, .right)
		: which == "middle" ? (.otherMouseDown, .otherMouseUp, .center)
		: (.leftMouseDown, .leftMouseUp, .left)
	mouse(.mouseMoved, p)
	usleep(60_000)
	for i in 1...count {
		mouse(down, p, button, clicks: Int64(i))
		mouse(up, p, button, clicks: Int64(i))
	}

case "drag":
	let a = CGPoint(x: num(1), y: num(2)), b = CGPoint(x: num(3), y: num(4))
	mouse(.mouseMoved, a)
	usleep(60_000)
	mouse(.leftMouseDown, a)
	let steps = 20
	for i in 1...steps {
		let t = Double(i) / Double(steps)
		mouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
		usleep(12_000)
	}
	mouse(.leftMouseUp, b)

case "scroll":
	// scroll x y dx dy   (positive dy scrolls content up i.e. reveals lower content, in lines)
	let p = CGPoint(x: num(1), y: num(2))
	mouse(.mouseMoved, p)
	usleep(60_000)
	let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: Int32(-num(4)), wheel2: Int32(-num(3)), wheel3: 0)
	post(e)

case "type":
	guard args.count > 1 else { fail("type <text>") }
	typeText(args[1])

case "key":
	guard args.count > 1 else { fail("key <combo>") }
	for combo in args.dropFirst() { pressKey(combo) }

default:
	fail("unknown command \(cmd)")
}

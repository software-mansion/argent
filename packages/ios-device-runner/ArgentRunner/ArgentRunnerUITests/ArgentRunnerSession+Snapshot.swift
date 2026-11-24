import XCTest

extension ArgentRunnerSession {
    /// Element types an agent can act on directly. These are always included.
    static let interactiveTypes: Set<XCUIElement.ElementType> = [
        .button, .cell, .checkBox, .collectionView, .datePicker, .link,
        .menuItem,
        .picker, .pickerWheel, .searchField, .segmentedControl, .slider,
        .stepper,
        .switch, .tabBar, .textField, .secureTextField, .textView, .toggle,
        .webView,
    ]

    /// Containers whose content scrolls. Included even when unlabeled so the
    /// tree shows where scrolling is possible.
    static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
        .scrollView, .table, .collectionView, .webView,
    ]

    /// Hard ceiling on emitted nodes. Bounds the reply size for very deep trees.
    static let snapshotNodeBudget = 1500

    /// Guard against cyclic or extremely deep raw trees.
    private static let rawDepthLimit = 100

    /// Ceiling on emitted node depth.
    private static let emittedDepthLimit = 60

    /// View services that present UI over the registered app from their own
    /// process. On iOS 26 the host app's tree no longer bridges into them, so
    /// an ASWebAuthenticationSession or SFSafariViewController sheet is missing
    /// from the app's snapshot even though it covers the screen.
    private static let hostedViewServiceBundleIds = ["com.apple.SafariViewService"]

    /// Share of the node budget a hosted service may use. A heavy web page
    /// must not crowd out the app's own nodes and the keyboard.
    private static let hostedNodeBudget = 1000

    /// Captures the app's accessibility tree and flattens it into a snapshot
    /// payload. The capture is retried once after a short pause: this is the
    /// one runner-side retry, kept here because the capture can read its own
    /// failure, a thrown error or an accessibility exception from a tree
    /// that moved mid-capture, and a moment is usually enough for the tree
    /// to settle. performOnMain only guards; the host retries read-only sends.
    func captureSnapshot(of app: XCUIApplication) -> Envelope {
        var root: XCUIElementSnapshot?
        var lastError = ""

        for attempt in 0..<2 {
            if attempt > 0 {
                NSLog("ARGENT_RUNNER_RETRY command=snapshot reason=%@", lastError)
                Thread.sleep(forTimeInterval: 0.4)
            }

            // One XPC round trip captures the whole tree. Flattening it in-process
            // avoids per-element AX queries and their stalls. The capture can throw
            // a Swift error or raise an accessibility NSException; the guard turns
            // the exception into a description instead of a crash.
            let exceptionDescription = ArgentExceptionGuard.runCatching {
                do {
                    root = try app.snapshot()
                } catch {
                    lastError = String(describing: error)
                }
            }

            if let exceptionDescription {
                lastError = exceptionDescription
            }

            if root != nil { break }
        }

        guard let root else {
            return .failure(
                .snapshotFailed,
                "XCTest could not capture the accessibility tree: \(lastError)",
                hint:
                    "Retry after the UI settles, or use screenshot as visual truth."
            )
        }

        let nodes = Self.flatten(root, hosted: hostedServiceRoots(over: root))
        let capped = nodes.count >= Self.snapshotNodeBudget

        return .success(
            SnapshotPayload(
                nodes: nodes,
                quality: SnapshotQualityPayload(
                    state: capped ? "degraded" : "healthy",
                    backend: "xctest",
                    reason: capped
                        ? "node budget reached; deeper content was dropped"
                        : nil,
                    reasonCode: capped ? "node_cap" : nil
                )
            )
        )
    }

    /// Trees of the hosted view services presenting over `root` right now.
    /// The service is read through a proxy and never activated: activating it
    /// would front it as a standalone app and black out the screen.
    ///
    /// Only a foreground service is read. A suspended one, where the service
    /// stays after its sheet closes, blocks `snapshot()` past the command
    /// watchdog and leaves the runner busy. A background one returns stale
    /// pieces of the closed sheet. A tree whose size differs from the app's
    /// belongs to a sheet still animating in or out, and its frames would
    /// mislead taps, so it is dropped too. A failure here never fails the
    /// app's own snapshot.
    private func hostedServiceRoots(over root: XCUIElementSnapshot)
        -> [XCUIElementSnapshot]
    {
        // Before iOS 26 the app's tree already carries the hosted browser.
        if Self.containsHostedBrowser(root) { return [] }

        var roots: [XCUIElementSnapshot] = []

        for bundleId in Self.hostedViewServiceBundleIds {
            let service = XCUIApplication(bundleIdentifier: bundleId)
            guard service.state == .runningForeground else { continue }

            var hosted: XCUIElementSnapshot?
            var failure: String?
            let started = Date()
            let exceptionDescription = ArgentExceptionGuard.runCatching {
                do {
                    hosted = try service.snapshot()
                } catch {
                    failure = String(describing: error)
                }
            }
            let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)

            guard let hosted, service.state == .runningForeground,
                Self.sameSize(hosted.frame, root.frame)
            else {
                NSLog(
                    "ARGENT_HOSTED_SKIPPED bundle=%@ ms=%d reason=%@",
                    bundleId, elapsedMs,
                    exceptionDescription ?? failure ?? "not settled on screen"
                )
                continue
            }

            NSLog("ARGENT_HOSTED bundle=%@ ms=%d", bundleId, elapsedMs)
            roots.append(hosted)
        }

        return roots
    }

    /// Whether the tree holds SafariViewService's browser container, whose
    /// identifier starts with "BrowserView". An app's own web view does not
    /// count. Bounded by the raw depth limit.
    private static func containsHostedBrowser(_ root: XCUIElementSnapshot)
        -> Bool
    {
        var stack: [(XCUIElementSnapshot, Int)] = [(root, 0)]

        while let (snapshot, depth) = stack.popLast() {
            if snapshot.identifier.hasPrefix("BrowserView") { return true }
            if depth >= rawDepthLimit { continue }
            stack.append(contentsOf: snapshot.children.map { ($0, depth + 1) })
        }

        return false
    }

    /// Whether two frames have the same size within a point.
    private static func sameSize(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }

    /// Flattens the snapshot tree into an ordered node list. Keeps elements an
    /// agent can name or act on, assigns indices and parent links in emission
    /// order, and dedupes mirror elements. `hosted` trees of view services
    /// presenting over the app are emitted first under the root, within
    /// their own share of the node budget. Every node emitted from a window
    /// that holds the on-screen keyboard, of the app or of a hosted view
    /// service, is marked `keyboard`.
    static func flatten(
        _ root: XCUIElementSnapshot,
        hosted: [XCUIElementSnapshot] = []
    ) -> [SnapshotNodePayload] {
        struct WorkItem {
            let snapshot: XCUIElementSnapshot
            let rawDepth: Int
            let emittedDepth: Int
            let parentIndex: Int
            let keyboard: Bool
            var hosted = false
        }

        let viewport = root.frame
        var nodes = [makeNode(root, index: 0, depth: 0, parentIndex: nil, keyboard: false)]
        var seen: Set<String> = [identity(root)]
        var hostedEmitted = 0

        var stack = root.children.reversed().map {
            WorkItem(
                snapshot: $0, rawDepth: 1, emittedDepth: 1, parentIndex: 0,
                keyboard: holdsKeyboard($0)
            )
        }

        // Pushed last so they are walked first: they cover the screen, and the
        // app's keyboard keys must not use up the budget before them.
        stack.append(
            contentsOf: hosted.reversed().map {
                WorkItem(
                    snapshot: $0, rawDepth: 1, emittedDepth: 1, parentIndex: 0,
                    keyboard: false, hosted: true
                )
            }
        )

        while let item = stack.popLast() {
            if nodes.count >= snapshotNodeBudget { break }
            if item.rawDepth > rawDepthLimit { continue }
            if item.hosted && hostedEmitted >= hostedNodeBudget { continue }

            let snapshot = item.snapshot
            let frame = snapshot.frame
            let visible =
                viewport.isEmpty
                || (!frame.isEmpty && viewport.intersects(frame))
            let include =
                visible && item.emittedDepth <= emittedDepthLimit
                && shouldInclude(snapshot)
            let key = identity(snapshot)
            let duplicate = seen.contains(key)

            var childParentIndex = item.parentIndex
            var childEmittedDepth = item.emittedDepth

            if include && !duplicate {
                seen.insert(key)

                let index = nodes.count

                nodes.append(
                    makeNode(
                        snapshot,
                        index: index,
                        depth: item.emittedDepth,
                        parentIndex: item.parentIndex,
                        keyboard: item.keyboard
                    )
                )

                childParentIndex = index
                childEmittedDepth += 1
                if item.hosted { hostedEmitted += 1 }
            }

            for child in snapshot.children.reversed() {
                stack.append(
                    WorkItem(
                        snapshot: child,
                        rawDepth: item.rawDepth + 1,
                        emittedDepth: childEmittedDepth,
                        parentIndex: childParentIndex,
                        // A hosted tree is an application: its windows are
                        // one level further down than the app's own.
                        keyboard: item.keyboard
                            || (item.hosted && item.rawDepth == 1 && holdsKeyboard(child)),
                        hosted: item.hosted
                    )
                )
            }
        }

        return nodes
    }

    /// Whether a window of the app (a child of its root) is the on-screen
    /// keyboard: it holds an element of type keyboard. The whole window is
    /// keyboard, not only that element: the prediction bar and the globe and
    /// dictation keys sit beside it. The keyboard element itself has no label,
    /// so the flatten drops it and its window, and this is the only place the
    /// boundary survives. A keyboard element that is a child of the root holds
    /// itself.
    static func holdsKeyboard(_ window: XCUIElementSnapshot) -> Bool {
        var stack: [(snapshot: XCUIElementSnapshot, depth: Int)] = [(window, 1)]
        while let item = stack.popLast() {
            if item.snapshot.elementType == .keyboard { return true }
            if item.depth < rawDepthLimit {
                for child in item.snapshot.children {
                    stack.append((child, item.depth + 1))
                }
            }
        }
        return false
    }

    /// Whether an element earns a node: interactive, a scroll container, or
    /// carrying any text.
    private static func shouldInclude(_ snapshot: XCUIElementSnapshot) -> Bool {
        if interactiveTypes.contains(snapshot.elementType) { return true }
        if scrollContainerTypes.contains(snapshot.elementType) { return true }

        return !snapshot.label.isEmpty || !snapshot.identifier.isEmpty
            || valueText(snapshot.value) != nil
    }

    /// Converts one element snapshot into a wire node payload.
    private static func makeNode(
        _ snapshot: XCUIElementSnapshot,
        index: Int,
        depth: Int,
        parentIndex: Int?,
        keyboard: Bool
    ) -> SnapshotNodePayload {
        let frame = snapshot.frame

        return SnapshotNodePayload(
            index: index,
            type: elementTypeName(snapshot.elementType),
            label: snapshot.label.isEmpty ? nil : snapshot.label,
            identifier: snapshot.identifier.isEmpty ? nil : snapshot.identifier,
            value: valueText(snapshot.value),
            // A geometry-less element reports CGRect.null with an infinite origin,
            // and JSONEncoder rejects non-finite doubles. Coordinates are forced
            // finite so one such node cannot fail the whole encode.
            rect: SnapshotRect(
                x: finite(frame.minX),
                y: finite(frame.minY),
                width: finite(frame.width),
                height: finite(frame.height)
            ),
            enabled: snapshot.isEnabled,
            focused: snapshot.hasFocus ? true : nil,
            selected: snapshot.isSelected ? true : nil,
            depth: depth,
            parentIndex: parentIndex,
            keyboard: keyboard ? true : nil
        )
    }

    /// Dedup key for one node. Mirror elements surfaced twice by the AX tree
    /// share type, texts, and geometry and collapse to the same key.
    private static func identity(_ snapshot: XCUIElementSnapshot) -> String {
        let frame = snapshot.frame

        return
            "\(snapshot.elementType.rawValue)|\(snapshot.label)|\(snapshot.identifier)|"
            + "\(keyCoordinate(frame.minX)),\(keyCoordinate(frame.minY)),"
            + "\(keyCoordinate(frame.width)),\(keyCoordinate(frame.height))"
    }

    /// Stable dedup-key text for one frame coordinate. The key needs to be
    /// stable, not exact.
    private static func keyCoordinate(_ v: CGFloat) -> String {
        // Int(_: Double) traps on non-finite or out-of-range input, and a trap
        // kills the runner process. Geometry-less elements do reach here with
        // CGRect.null frames, so every conversion must be total.
        guard v.isFinite else { return String(describing: v) }

        return String(Int(min(max(v.rounded(), -1e15), 1e15)))
    }

    /// Collapses a non-finite coordinate to 0 for the wire payload.
    private static func finite(_ v: CGFloat) -> Double {
        v.isFinite ? Double(v) : 0
    }

    /// The element's value as wire text, nil when absent or empty.
    private static func valueText(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        let text = String(describing: value)
        return text.isEmpty ? nil : text
    }

    /// Stable type names for the wire payload. The TypeScript describe adapter
    /// maps them onto accessibility roles.
    static func elementTypeName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .any: return "Any"
        case .other: return "Other"
        case .application: return "Application"
        case .group: return "Group"
        case .window: return "Window"
        case .sheet: return "Sheet"
        case .drawer: return "Drawer"
        case .alert: return "Alert"
        case .dialog: return "Dialog"
        case .button: return "Button"
        case .radioButton: return "RadioButton"
        case .radioGroup: return "RadioGroup"
        case .checkBox: return "CheckBox"
        case .disclosureTriangle: return "DisclosureTriangle"
        case .popUpButton: return "PopUpButton"
        case .comboBox: return "ComboBox"
        case .menuButton: return "MenuButton"
        case .toolbarButton: return "ToolbarButton"
        case .popover: return "Popover"
        case .keyboard: return "Keyboard"
        case .key: return "Key"
        case .navigationBar: return "NavigationBar"
        case .tabBar: return "TabBar"
        case .tabGroup: return "TabGroup"
        case .toolbar: return "Toolbar"
        case .statusBar: return "StatusBar"
        case .table: return "Table"
        case .tableRow: return "TableRow"
        case .tableColumn: return "TableColumn"
        case .outline: return "Outline"
        case .outlineRow: return "OutlineRow"
        case .browser: return "Browser"
        case .collectionView: return "CollectionView"
        case .slider: return "Slider"
        case .pageIndicator: return "PageIndicator"
        case .progressIndicator: return "ProgressIndicator"
        case .activityIndicator: return "ActivityIndicator"
        case .segmentedControl: return "SegmentedControl"
        case .picker: return "Picker"
        case .pickerWheel: return "PickerWheel"
        case .switch: return "Switch"
        case .toggle: return "Toggle"
        case .link: return "Link"
        case .image: return "Image"
        case .icon: return "Icon"
        case .searchField: return "SearchField"
        case .scrollView: return "ScrollView"
        case .scrollBar: return "ScrollBar"
        case .staticText: return "StaticText"
        case .textField: return "TextField"
        case .secureTextField: return "SecureTextField"
        case .datePicker: return "DatePicker"
        case .textView: return "TextView"
        case .menu: return "Menu"
        case .menuItem: return "MenuItem"
        case .menuBar: return "MenuBar"
        case .menuBarItem: return "MenuBarItem"
        case .map: return "Map"
        case .webView: return "WebView"
        case .incrementArrow: return "IncrementArrow"
        case .decrementArrow: return "DecrementArrow"
        case .timeline: return "Timeline"
        case .ratingIndicator: return "RatingIndicator"
        case .valueIndicator: return "ValueIndicator"
        case .splitGroup: return "SplitGroup"
        case .splitter: return "Splitter"
        case .relevanceIndicator: return "RelevanceIndicator"
        case .colorWell: return "ColorWell"
        case .helpTag: return "HelpTag"
        case .matte: return "Matte"
        case .dockItem: return "DockItem"
        case .ruler: return "Ruler"
        case .rulerMarker: return "RulerMarker"
        case .grid: return "Grid"
        case .levelIndicator: return "LevelIndicator"
        case .cell: return "Cell"
        case .layoutArea: return "LayoutArea"
        case .layoutItem: return "LayoutItem"
        case .handle: return "Handle"
        case .stepper: return "Stepper"
        case .tab: return "Tab"
        case .touchBar: return "TouchBar"
        case .statusItem: return "StatusItem"
        @unknown default: return "Other"
        }
    }
}

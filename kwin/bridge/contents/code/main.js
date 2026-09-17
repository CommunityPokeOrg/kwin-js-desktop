/*
 * PokeDE Window Bridge — runs inside KWin's script engine (KWin 5.24+ and KWin 6).
 *
 * Publishes window lifecycle/state to the session D-Bus registry:
 *   service   org.communitypoke.desktop.Registry
 *   path      /org/communitypoke/desktop/Registry
 *   interface org.communitypoke.desktop.Registry
 *   methods   Sync(s json), ReportWindow(s json), RemoveWindow(s key), FocusChanged(s key)
 *
 * API naming changed between KWin 5 (clientAdded / clientList / AbstractClient)
 * and KWin 6 (windowAdded / windowList / Window). Both spellings are probed via
 * connectAny()/anyProp(); whichever exists on this KWin is what gets used.
 */

var REGISTRY_SERVICE = "org.communitypoke.desktop.Registry";
var REGISTRY_PATH = "/org/communitypoke/desktop/Registry";
var REGISTRY_IFACE = "org.communitypoke.desktop.Registry";

function log(msg) {
    try { print("pokede-bridge: " + msg); } catch (e) { /* engine without print */ }
}

/* Fire-and-forget D-Bus call to the registry. workspace.callDBus exists in both
 * KWin 5 and 6; the bare callDBus global is kept as a fallback for engines that
 * expose it at top level. Absent both, events are dropped silently — the bridge
 * re-syncs on the next structural event, so a transient registry outage heals. */
function emit(method, arg) {
    var args = [REGISTRY_SERVICE, REGISTRY_PATH, REGISTRY_IFACE, method];
    if (arg !== undefined) args.push(arg);
    try {
        if (typeof workspace !== "undefined" && typeof workspace.callDBus === "function") {
            workspace.callDBus.apply(workspace, args);
        } else if (typeof callDBus === "function") {
            callDBus.apply(null, args);
        }
    } catch (e) {
        log("emit " + method + " failed: " + e);
    }
}

/* First defined property among candidate names (KWin 5 vs 6 spelling). */
function anyProp(obj, names) {
    for (var i = 0; i < names.length; i++) {
        try {
            var v = obj[names[i]];
            if (v !== undefined && v !== null) return v;
        } catch (e) { /* property absent on this version */ }
    }
    return null;
}

function num(v, dflt) {
    return (typeof v === "number" && isFinite(v)) ? v : (dflt === undefined ? 0 : dflt);
}

function bool(v) {
    return v === true || v === 1;
}

function rect(r) {
    if (!r) return null;
    return {
        x: num(r.x), y: num(r.y),
        width: num(r.width), height: num(r.height)
    };
}

function keyFor(w) {
    var k = anyProp(w, ["internalId", "frameId", "windowId"]);
    return k === null ? "unknown" : String(k);
}

/* Window-class heuristic. Layer-shell / shell furniture (QuickShell panels,
 * plasmashell, notifications) surface as "special" windows on Wayland; on X11
 * the same roles appear as dock/desktop/override-redirect. Anything that is
 * not a normal managed window is flagged so the registry/apps can filter. */
function kindFor(w) {
    if (bool(anyProp(w, ["desktopWindow"]))) return "desktop";
    if (bool(anyProp(w, ["dock"]))) return "dock";
    if (bool(anyProp(w, ["notification"]))) return "notification";
    if (bool(anyProp(w, ["criticalNotification"]))) return "notification";
    if (bool(anyProp(w, ["onScreenDisplay"]))) return "osd";
    if (bool(anyProp(w, ["splash"]))) return "splash";
    if (bool(anyProp(w, ["toolbar"]))) return "toolbar";
    if (bool(anyProp(w, ["utility"]))) return "utility";
    if (bool(anyProp(w, ["dialog"]))) return "dialog";
    if (bool(anyProp(w, ["menu"]))) return "menu";
    var wt = anyProp(w, ["windowType"]);
    if (wt !== null && num(wt) !== 0) return "type:" + wt;
    return "normal";
}

function serialize(w) {
    var geom = rect(anyProp(w, ["frameGeometry", "geometry"]));
    var win = {
        key: keyFor(w),
        windowId: num(anyProp(w, ["windowId"]), -1),
        pid: num(anyProp(w, ["pid"]), -1),
        caption: String(anyProp(w, ["caption"]) || ""),
        resourceName: String(anyProp(w, ["resourceName"]) || ""),
        resourceClass: String(anyProp(w, ["resourceClass"]) || ""),
        windowRole: String(anyProp(w, ["windowRole"]) || ""),
        desktop: num(anyProp(w, ["desktop"]), -1),
        screen: num(anyProp(w, ["screen", "output"]), -1),
        geometry: geom,
        minimized: bool(anyProp(w, ["minimized"])),
        active: bool(anyProp(w, ["active"])),
        fullScreen: bool(anyProp(w, ["fullScreen"])),
        maximized: bool(anyProp(w, ["maximized", "maximizable"])),
        shaded: bool(anyProp(w, ["shade", "shaded"])),
        onAllDesktops: bool(anyProp(w, ["onAllDesktops"])),
        keepAbove: bool(anyProp(w, ["keepAbove"])),
        keepBelow: bool(anyProp(w, ["keepBelow"])),
        skipTaskbar: bool(anyProp(w, ["skipTaskbar"])),
        skipPager: bool(anyProp(w, ["skipPager"])),
        transient: bool(anyProp(w, ["transient"])),
        modal: bool(anyProp(w, ["modal"])),
        demandsAttention: bool(anyProp(w, ["demandsAttention", "urgent"])),
        kind: kindFor(w),
        ts: Date.now ? Date.now() : 0
    };
    return JSON.stringify(win);
}

function listWindows() {
    try {
        if (typeof workspace.windowList === "function") return workspace.windowList();
        if (typeof workspace.clientList === "function") return workspace.clientList();
    } catch (e) {
        log("window list failed: " + e);
    }
    return [];
}

/* Connect whichever of the candidate signal names exists on obj. */
function connectAny(obj, names, cb) {
    for (var i = 0; i < names.length; i++) {
        try {
            var sig = obj[names[i]];
            if (sig && typeof sig.connect === "function") {
                sig.connect(cb);
                return names[i];
            }
        } catch (e) { /* signal absent on this version */ }
    }
    return null;
}

function syncAll() {
    var wins = listWindows();
    var out = [];
    for (var i = 0; i < wins.length; i++) out.push(serialize(wins[i]));
    emit("Sync", JSON.stringify(out));
}

var WATCH_SIGNALS = [
    ["geometryChanged", "clientGeometryChanged", "frameGeometryChanged"],
    ["minimizedChanged"],
    ["activeChanged"],
    ["captionChanged", "windowCaptionChanged"],
    ["desktopChanged"],
    ["screenChanged", "outputChanged"],
    ["fullScreenChanged", "clientFullScreenChanged"],
    ["maximizedChanged"],
    ["iconChanged"],
    ["skipTaskbarChanged"],
    ["shadeChanged", "shadedChanged"],
    ["demandsAttentionChanged", "urgencyChanged"],
    ["transientChanged"],
    ["modalChanged"],
    ["closeableChanged"],
    ["keepAboveChanged"],
    ["keepBelowChanged"],
    ["onAllDesktopsChanged"]
];

function watchWindow(w) {
    for (var i = 0; i < WATCH_SIGNALS.length; i++) {
        (function (win, names) {
            connectAny(win, names, function () {
                emit("ReportWindow", serialize(win));
            });
        })(w, WATCH_SIGNALS[i]);
    }
}

function onAdded(w) {
    try {
        watchWindow(w);
        emit("ReportWindow", serialize(w));
        syncAll();
    } catch (e) {
        log("onAdded failed: " + e);
    }
}

function onRemoved(w) {
    try {
        emit("RemoveWindow", keyFor(w));
        syncAll();
    } catch (e) {
        log("onRemoved failed: " + e);
    }
}

function onActivated(w) {
    if (!w) return;
    try {
        emit("ReportFocus", keyFor(w));
        emit("ReportWindow", serialize(w));
    } catch (e) { /* activation burst during teardown */ }
}

function onDesktopChanged() {
    syncAll();
}

var hooked = [];
hooked.push(["add", connectAny(workspace, ["windowAdded", "clientAdded"], onAdded)]);
hooked.push(["remove", connectAny(workspace, ["windowRemoved", "clientRemoved"], onRemoved)]);
hooked.push(["activate", connectAny(workspace, ["windowActivated", "clientActivated"], onActivated)]);
hooked.push(["desktop", connectAny(workspace, ["currentDesktopChanged", "currentDesktopChanged"], onDesktopChanged)]);

for (var i = 0; i < hooked.length; i++) {
    if (!hooked[i][1]) log("no usable signal for " + hooked[i][0]);
}

var existing = listWindows();
for (var j = 0; j < existing.length; j++) watchWindow(existing[j]);
syncAll();
log("loaded; tracking " + existing.length + " window(s)");

// Example KDE-level automation: whenever a normal window is added, log where
// a tiler would place it, and keep new utility windows off desktop 1.
// Run:  pokede run examples/tile-new-windows.js
//
// Window mutation goes through KWin's own D-Bus surface — the registry is
// event/state only. desktop.dbus.call reaches any session service; KWin
// exposes org.kde.KWin (e.g. /KWin org.kde.KWin for core ops, and the
// /Scripting object used by desktop.kwin.scripting).

desktop.windows.on('added', async (w) => {
    if (w.kind !== 'normal') {
        desktop.log(`skipping ${w.kind} window "${w.caption}"`);
        return;
    }
    desktop.log(`new normal window: ${w.resourceClass || w.resourceName} "${w.caption}"`);
    // Illustrative: a real tiler would call a KWin script method or the
    // KWin D-Bus API to move/resize w.windowId here.
});

if (!(await desktop.kwin.available())) {
    desktop.log('KWin scripting service not available on this session bus');
} else {
    desktop.log(`bridge loaded in KWin: ${await desktop.kwin.scripting.isScriptLoaded('pokede-bridge')}`);
}

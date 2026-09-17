// Watch the window list through the PokeDE desktop API.
// Run:  pokede run examples/watch-windows.js
// Stop: Ctrl-C (the script stays alive on the D-Bus signal subscription).

const wins = await desktop.windows.list();
desktop.log(`tracking ${wins.length} window(s)`);
for (const w of wins) {
    desktop.log(`  ${w.kind} ${w.resourceClass || w.resourceName} "${w.caption}" geo=${JSON.stringify(w.geometry)}`);
}

desktop.windows.on('added', (w) => desktop.log(`+ ${w.resourceClass || w.resourceName} "${w.caption}" (${w.kind})`));
desktop.windows.on('removed', (key) => desktop.log(`- ${key}`));
desktop.windows.on('changed', (w) => {
    if (w.active) desktop.log(`focus -> ${w.resourceClass || w.resourceName} "${w.caption}"`);
});
desktop.windows.onFocus((w) => desktop.log(`focused: "${w.caption}"`));

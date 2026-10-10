// Opt-in GPU acceptance checks against the packaged viewer. Start it with the
// library-stats fixture (or a synthetic export with dated and undated albums)
// and an isolated Chromium
// debugging port, then run:
// TIMELINE_BROWSER_URL=http://127.0.0.1:8798/?data=data.json \
// TIMELINE_CDP_URL=http://127.0.0.1:9338 node tests/timeline-browser.mjs
// The shipped bundle is checked first. A second load intercepts only app.js
// with the same source plus test-local accessors for exact GPU pose assertions.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { cosmosAtlasPlugin } from '../cosmos-atlas-patch.mjs';
import { TIMELINE_DOCK_KEY } from '../timeline.mjs';

const url = process.env.TIMELINE_BROWSER_URL;
const cdp = process.env.TIMELINE_CDP_URL;
if (!url || !cdp) throw new Error('Set TIMELINE_BROWSER_URL and TIMELINE_CDP_URL to isolated local viewer/browser endpoints.');
const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0, intercepted, previousDockPreference;
const dockKey = JSON.stringify(TIMELINE_DOCK_KEY);
const pending = new Map(), exceptions = [], checks = [];
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id);
    if (request) message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    exceptions.push(message.params.args.map(arg => arg.description ?? arg.value).join(' '));
  } else if (message.method === 'Fetch.requestPaused') {
    void call('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }],
      body: Buffer.from(intercepted).toString('base64') }).catch(error => exceptions.push(String(error)));
  }
};
const evaluate = async expression => {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function wait(expression) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Browser did not reach: ${expression}\n${await evaluate('document.querySelector("#status")?.textContent')}`);
}
async function check(expression, label) {
  assert.ok(await evaluate(expression), label); checks.push(label);
}
async function input(id, value, event = 'input') {
  await evaluate(`(() => { const element = document.getElementById(${JSON.stringify(id)});
    element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
}
async function key(value, id = 'timeline-playhead') {
  if (id !== null) await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
  const windowsVirtualKeyCode = { Enter:13, ' ':32, Tab:9, Escape:27, Home:36, End:35, ArrowLeft:37, ArrowRight:39 }[value];
  const text = value === 'Enter' ? '\r' : value === ' ' ? ' ' : undefined;
  const fields = { key:value, code:value === ' ' ? 'Space' : value, windowsVirtualKeyCode, nativeVirtualKeyCode:windowsVirtualKeyCode };
  await call('Input.dispatchKeyEvent', { type:'keyDown', ...fields, text, unmodifiedText:text });
  await call('Input.dispatchKeyEvent', { type:'keyUp', ...fields });
}
async function reload() {
  await call('Page.reload', { ignoreCache: true });
  await wait(`!!document.querySelector('#graph canvas') && !document.getElementById('timeline').hidden && !document.getElementById('search').disabled`);
}
async function screenshot(name) {
  if (!process.env.TIMELINE_SCREENSHOT_DIR) return;
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${process.env.TIMELINE_SCREENSHOT_DIR}/${name}.png`, Buffer.from(shot.data, 'base64'));
}
const deadline = setTimeout(() => { socket.close(); throw new Error('Timeline browser checks exceeded 3 minutes'); }, 180000);
try {
  await call('Page.enable'); await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url });
  await wait(`!!document.querySelector('#graph canvas') && !document.getElementById('timeline').hidden && !document.getElementById('search').disabled`);
  previousDockPreference = await evaluate(`localStorage.getItem(${dockKey})`);
  await evaluate(`localStorage.removeItem(${dockKey})`);
  await reload();
  await check(`document.getElementById('timeline-toggle').getAttribute('aria-expanded') === 'true' &&
    !document.getElementById('timeline-content').hidden`, 'desktop defaults to an expanded timeline');
  await check(`(() => { const gl = document.querySelector('#graph canvas').getContext('webgl2');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return !!info && !/swiftshader|llvmpipe|software/i.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)); })()`, 'packaged viewer uses hardware WebGL 2');
  await wait(`document.getElementById('cover-status').textContent.includes('covers in view')`);
  await check(`document.getElementById('cover-status').textContent.includes('0 unavailable')`, 'packaged fixture covers load successfully');
  await key('Home');
  await check(`document.getElementById('timeline-readout').textContent.includes('Snapshot 0 /') &&
    document.getElementById('timeline-readout').textContent.includes('Shown on map 0 /')`, 'packaged before-first snapshot is empty');
  await key('End');
  await check(`document.getElementById('timeline-playhead').value !== document.getElementById('timeline-playhead').max &&
    document.getElementById('group').disabled`, 'packaged End selects finite history');
  await key('Escape');
  await check(`document.getElementById('timeline-readout').textContent.startsWith('Latest') &&
    !document.getElementById('group').disabled`, 'packaged Escape restores Latest');
  await screenshot('packaged-desktop');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await reload();
  await check(`document.getElementById('timeline-content').hidden &&
    document.getElementById('timeline-compact').textContent === 'Latest' &&
    document.getElementById('timeline-toggle').getAttribute('aria-label') === 'Show timeline' &&
    localStorage.getItem(${dockKey}) === null`, '390px defaults to a docked pill without persisting the default');
  await key('Enter', 'timeline-toggle');
  await wait(`!document.getElementById('timeline-content').hidden`);
  await key('Home'); await key('ArrowRight');
  await evaluate(`globalThis.packagedCutoff = document.getElementById('timeline-playhead').value;
    globalThis.packagedReadout = document.getElementById('timeline-readout').textContent;
    globalThis.packagedHeight = parseFloat(document.querySelector('main').style.getPropertyValue('--timeline-height'));
    document.getElementById('timeline-toggle').click();`);
  await wait(`parseFloat(document.querySelector('main').style.getPropertyValue('--timeline-height')) < packagedHeight`);
  await check(`document.getElementById('timeline-playhead').value === packagedCutoff &&
    document.getElementById('timeline-readout').textContent === packagedReadout && document.getElementById('group').disabled &&
    document.getElementById('timeline-compact').textContent.startsWith('Snapshot:') &&
    document.activeElement.id === 'timeline-toggle' && document.getElementById('timeline-content').hidden &&
    document.getElementById('timeline-toggle').getAttribute('aria-controls') === 'timeline-content'`, 'packaged docking preserves history, exposes the compact date and rescues playhead focus');
  await key('Escape', 'timeline-toggle');
  await check(`document.getElementById('timeline-compact').textContent === 'Latest' &&
    document.getElementById('timeline-content').hidden && document.activeElement.id === 'timeline-toggle'`, 'Escape on the docked toggle restores Latest and keeps the pill docked');
  await reload();
  await check(`document.getElementById('timeline-content').hidden`, 'docked choice survives a mobile reload');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await reload();
  await check(`document.getElementById('timeline-content').hidden`, 'saved docked choice overrides the desktop default');
  await key(' ', 'timeline-toggle'); await reload();
  await check(`!document.getElementById('timeline-content').hidden`, 'expanded choice survives a desktop reload');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await reload();
  await check(`!document.getElementById('timeline-content').hidden`, 'saved expanded choice overrides the mobile default');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const directory = fileURLToPath(new URL('../', import.meta.url));
  const source = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const hooks = `\nglobalThis.__timelineTest = {
    get graph() { return graph }, get selection() { return selection }, get data() { return data },
    get timeline() { return timeline }, get position() { return timelinePosition },
    get gather() { return gather }, get historical() { return historical },
    get segments() { return timelineSegments }, get colors() { return timelineColors },
    get groupNames() { return groupNames },
    get labels() { return labelGroups }, get selected() { return selected },
    setPosition: setTimelinePosition, load, showInfo, updateSearch,
    phrase() { phraseResult = { salience: data.albums.map((_, i) => i % 2 ? 0 : 3),
      cosines: data.albums.map((_, i) => i % 2 ? .1 : .9) }; updateSearch(); },
    clearPhrase() { phraseResult = undefined; updateSearch(); },
    snapshot() { return { positions: Array.from(graph.getPointPositions()),
      camera: Array.from(graph.screenToSpacePosition([0, 0])), zoom: graph.getZoomLevel(),
      visible: selection.visibleIndices, matches: selection.matches, running: graph.isSimulationRunning,
      progress: graph.store.simulationProgress, alpha: graph.store.alpha }; }
  };`;
  const bundle = await build({ stdin: { contents: source + hooks, resolveDir: directory, sourcefile: 'app.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', plugins: [cosmosAtlasPlugin] });
  intercepted = bundle.outputFiles[0].text;
  await call('Fetch.enable', { patterns: [{ urlPattern: '*/app.js*' }] });
  await call('Page.reload', { ignoreCache: true });
  await wait(`!!globalThis.__timelineTest?.graph && !document.getElementById('timeline-playhead').disabled && !document.getElementById('search').disabled`);
  const firstTitle = await evaluate(`__timelineTest.data.albums[0].album`);
  await evaluate(`globalThis.t = __timelineTest; globalThis.calls = { pause: 0, resume: 0, start: 0 };
    for (const [method, counter] of [['pause','pause'], ['unpause','resume'], ['start','start']]) {
      const original = t.graph[method].bind(t.graph);
      t.graph[method] = (...args) => { calls[counter]++; return original(...args); };
    }`);
  await input('group', 'year', 'change');
  await evaluate(`globalThis.fullEntry = t.snapshot(); t.setPosition(t.timeline.bins.length - 1); globalThis.baseline = t.snapshot();
    globalThis.structure = JSON.stringify(t.timeline.bins.map(b => [b.start, b.end, b.count]));
    globalThis.scale = t.timeline.maxCount;`);
  await check(`t.historical && !t.graph.isSimulationRunning && document.getElementById('group').value === 'cluster' &&
    document.getElementById('pause').disabled`, 'history freezes native physics and forces community grouping');
  await check(`t.selection.states.every((state, i) => state.visible === (Number.isFinite(t.timeline.dates[i])))`, 'finite final snapshot hides every undated album');
  await evaluate(`t.setPosition(-1)`); await sleep(150);
  await check(`t.graph.getPointPositions().every(Number.isNaN) && t.selection.active &&
    t.graph.getLinkColors().every(value => value === 0)`, 'backward scrub removes nodes and all incident links');
  await evaluate(`t.setPosition(t.timeline.bins.length - 1)`); await sleep(150);
  await check(`JSON.stringify(t.snapshot().positions) === JSON.stringify(baseline.positions) &&
    JSON.stringify(t.snapshot().camera) === JSON.stringify(baseline.camera) && t.graph.getZoomLevel() === baseline.zoom`, 'forward scrub restores identical world coordinates and camera');
  await check(`calls.pause === 1 && calls.resume === 0 && calls.start === 0`, 'scrubbing pauses once without starting or resuming physics');
  await evaluate(`t.setPosition(null); globalThis.fullExit = t.snapshot();
    calls = { pause: 0, resume: 0, start: 0 }; t.setPosition(t.timeline.bins.length - 1);
    baseline = t.snapshot();`);
  await check(`JSON.stringify(fullEntry.positions) === JSON.stringify(fullExit.positions) &&
    JSON.stringify(fullEntry.camera) === JSON.stringify(fullExit.camera) && fullEntry.zoom === fullExit.zoom &&
    fullEntry.alpha === fullExit.alpha && fullEntry.progress === fullExit.progress`, 'Latest restores every album before resumed motion and retains simulation progress');
  await check(`t.graph.getPointColors().every((channel, i) => i % 4 === 3 ||
    Math.abs(channel - Number(t.colors.get(t.groupNames[Math.floor(i / 4)]).match(/\\d+/g)[i % 4]) / 255) < 1e-6)`, 'histogram and graph use identical community colors');
  await input('search', firstTitle);
  await check(`t.selection.visibleIndices.length === 1 && t.selection.visibleIndices.every(i => t.timeline.dates[i] < t.timeline.bins.at(-1).end)`, 'search composes with the cutoff');
  await check(`(() => { const rect = document.getElementById('graph').getBoundingClientRect();
    return t.graph.findPointsInRect([[0,0],[rect.width,rect.height]]).every(i => t.selection.states[i].visible) &&
      [...document.querySelectorAll('#search-list button')].length === 1; })()`, 'hidden albums stay out of native picking and search results');
  await input('search', '');
  await evaluate(`t.phrase()`);
  await check(`t.selection.visibleIndices.length > t.selection.matches.length && !t.graph.isSimulationRunning &&
    JSON.stringify(t.snapshot().camera) === JSON.stringify(baseline.camera)`, 'phrase completion preserves eligibility counts and frozen camera');
  if (await evaluate(`!document.getElementById('phrase').disabled`)) {
    await evaluate(`globalThis.originalFetch = fetch; globalThis.phraseRequests = 0;
      globalThis.fetch = async (resource, options) => {
        if (resource !== '/api/embed-text') return originalFetch(resource, options);
        phraseRequests++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return new Response(JSON.stringify({ model_id: t.data.text_model_id,
          vector: Array.from({length:512},(_,i)=>i===0?1:0) }), {status:200});
      };`);
    await input('phrase', 'timeline validation sound');
    await wait(`phraseRequests === 1 && t.selection.vibeActive && document.getElementById('phrase-status').textContent.includes('Ranked')`);
    await check(`!t.graph.isSimulationRunning && calls.start === 0 &&
      JSON.stringify(t.snapshot().camera) === JSON.stringify(baseline.camera) &&
      t.selection.visibleIndices.every(i=>Number.isFinite(t.timeline.dates[i]))`, 'actual asynchronous phrase response reapplies the cutoff without moving the map');
    await evaluate(`globalThis.fetch = originalFetch; document.getElementById('clear-phrase').click()`);
  }
  await evaluate(`t.clearPhrase(); t.showInfo(t.selection.visibleIndices.at(-1), false); t.setPosition(-1)`);
  await check(`document.getElementById('details').hidden`, 'scrubbing out the selected album clears details');
  await evaluate(`t.setPosition(t.timeline.bins.length - 1)`);
  await input('k', '3'); await sleep(500);
  await check(`JSON.stringify(t.timeline.bins.map(b => [b.start,b.end,b.count])) === structure &&
    t.timeline.maxCount === scale && !t.graph.isSimulationRunning && calls.start === 0 && calls.pause === 1`, 'worker repartition preserves bins, heights and historical suspension');
  await check(`t.segments.every((segments,i)=>segments.reduce((sum,s)=>sum+s.count,0)===t.timeline.bins[i].count) &&
    t.graph.getPointColors().every((channel,i)=>i%4===3 ||
      Math.abs(channel-Number(t.colors.get(t.groupNames[Math.floor(i/4)]).match(/\\d+/g)[i%4])/255)<1e-6)`, 'repartition rebuilds every community stack and recolors histogram and graph together');
  await input('search', firstTitle);
  await evaluate(`globalThis.exitPose = t.snapshot(); t.setPosition(null);
    globalThis.restoredImmediately = t.snapshot();`);
  await check(`document.getElementById('group').value === 'year' && !document.getElementById('group').disabled &&
    t.selection.visibleIndices.length === 1 && calls.resume === 1 && calls.start === 0 &&
    JSON.stringify(exitPose.camera) === JSON.stringify(restoredImmediately.camera) && exitPose.zoom === restoredImmediately.zoom`, 'Latest preserves current filters, restores grouping and unpauses without reheating');

  await input('search', '');
  await evaluate(`t.graph.pause(); globalThis.settledResume = calls.resume; t.setPosition(-1); t.setPosition(null)`);
  await check(`calls.resume === settledResume && !t.graph.isSimulationRunning`, 'already settled simulation remains settled on Latest');
  await evaluate(`document.getElementById('pause').click(); t.setPosition(-1); t.setPosition(null)`);
  await check(`document.getElementById('pause').getAttribute('aria-pressed') === 'true' && !t.graph.isSimulationRunning`, 'user-paused physics remains paused');
  await evaluate(`t.phrase(); document.getElementById('gather').click();
    globalThis.canonical = Array.from(t.gather.canonical(t.graph.getPointPositions())); t.setPosition(-1);
    t.setPosition(t.timeline.bins.length - 1);`);
  await check(`t.gather.saved.size === 0 && !t.gather.orbit && t.graph.getPointPositions().every((value, i) =>
    !t.selection.states[Math.floor(i / 2)].visible || value === canonical[i]) && document.getElementById('gather').disabled`, 'Gather entry restores canonical positions synchronously and disables Gather');
  await evaluate(`t.setPosition(null); document.getElementById('gather').click();
    globalThis.returnCanonical = Array.from(t.gather.canonical(t.graph.getPointPositions()));
    document.getElementById('gather').click(); t.setPosition(t.timeline.bins.length - 1);`);
  await check(`t.gather.saved.size === 0 && t.graph.getPointPositions().every((value, i) =>
    !t.selection.states[Math.floor(i / 2)].visible || value === returnCanonical[i])`, 'mid-return Gather entry restores canonical positions');
  await key('Home'); await key('ArrowRight');
  await check(`t.position === 0 && document.activeElement.id === 'timeline-playhead' &&
    document.getElementById('timeline-playhead').getAttribute('aria-valuetext').includes('Snapshot')`, 'keyboard scrubbing retains focus and exposes accessible date/count');
  await key('End');
  await check(`t.position === t.timeline.bins.length - 1`, 'End remains distinct from Latest');
  await key('Escape');
  await check(`t.position === null && document.activeElement.id === 'timeline-playhead'`, 'timeline Escape restores Latest without moving focus');
  await screenshot('desktop');

  for (const [width, height] of [[1024, 768], [390, 844], [320, 568]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 761 });
    await sleep(250);
    await check(`(() => { const tray = document.getElementById('timeline').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && ['.map-toolbar','.map-footer'].every(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return rect.bottom <= tray.top && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0;
      }) && tray.bottom <= innerHeight; })()`, `tray and navigation remain reachable at ${width}×${height}`);
    await evaluate(`t.setPosition(t.timeline.bins.length - 1); t.showInfo(t.selection.visibleIndices[0],false)`); await sleep(150);
    await check(`(() => { const main=document.querySelector('main').getBoundingClientRect(),
      card=document.getElementById('details').getBoundingClientRect(), close=document.getElementById('clear').getBoundingClientRect(),
      tray=document.getElementById('timeline').getBoundingClientRect();
      return card.top >= main.top && card.bottom <= tray.top && close.top >= main.top; })()`, `selection card and close control remain above the tray at ${width}×${height}`);
    await check(`(() => { const cover=document.querySelector('.detail-header .detail-cover').getBoundingClientRect(),
      title=document.querySelector('.detail-heading h2').getBoundingClientRect(),
      close=document.getElementById('clear').getBoundingClientRect(), expected=innerWidth<761?44:56;
      return cover.width === expected && cover.height === expected && cover.right <= title.left &&
        title.right <= close.left && close.width === 44 && close.height === 44 &&
        !!document.querySelector('.album-subline') && !!document.querySelector('.album-facts');
    })()`, `compact album header and inline facts survive alongside the timeline at ${width}×${height}`);
    if (width < 761) await check(`(() => { const toggle=document.getElementById('settings-toggle'),
      rect=toggle.getBoundingClientRect(), svg=toggle.querySelector('svg').getBoundingClientRect();
      return rect.width === 42 && rect.height === 42 && svg.width === 20 && svg.height === 20 &&
        toggle.querySelector('path').getAttribute('d') === 'M4 7h1.5M10.5 7H20M4 17h9.5M18.5 17H20';
    })()`, `updated map settings icon stays intact at ${width}×${height}`);
    await evaluate(`globalThis.dockBefore = { position:t.position, snapshot:t.snapshot(), calls:{...calls},
      height:parseFloat(document.querySelector('main').style.getPropertyValue('--timeline-height')),
      footer:document.querySelector('.map-footer').getBoundingClientRect().bottom,
      toolbar:document.querySelector('.map-toolbar').getBoundingClientRect().bottom,
      details:document.getElementById('details').getBoundingClientRect() };
      document.getElementById('timeline-playhead').focus(); document.getElementById('timeline-toggle').click();`);
    await sleep(150);
    await check(`(() => { const tray=document.getElementById('timeline').getBoundingClientRect(),
      reserved=parseFloat(document.querySelector('main').style.getPropertyValue('--timeline-height')),
      reclaimed=dockBefore.height-reserved, card=document.getElementById('details').getBoundingClientRect();
      return reclaimed>60 && reserved===Math.ceil(tray.height+parseFloat(getComputedStyle(document.getElementById('timeline')).bottom)+8) &&
        Math.abs(document.querySelector('.map-footer').getBoundingClientRect().bottom-dockBefore.footer-reclaimed)<1 &&
        Math.abs(document.querySelector('.map-toolbar').getBoundingClientRect().bottom-dockBefore.toolbar-reclaimed)<1 &&
        tray.width<innerWidth-16 && tray.left>=0 && tray.right<=innerWidth && tray.bottom<=innerHeight &&
        card.height>=dockBefore.details.height && card.bottom<=tray.top &&
        (innerWidth>760 || Math.abs(card.bottom-dockBefore.details.bottom-reclaimed)<1);
    })()`, `docking reclaims measured space for navigation and details at ${width}×${height}`);
    await check(`(() => { const obstacles=['#timeline','.map-toolbar','.map-footer'].map(selector=>document.querySelector(selector).getBoundingClientRect());
      return [...document.querySelectorAll('.map-label')].filter(label=>getComputedStyle(label).visibility==='visible').every(label=> {
        const rect=label.getBoundingClientRect(); return obstacles.every(obstacle=>rect.bottom<=obstacle.top ||
          rect.top>=obstacle.bottom || rect.right<=obstacle.left || rect.left>=obstacle.right);
      });
    })()`, `labels avoid the docked pill and repositioned navigation at ${width}×${height}`);
    await check(`t.position===dockBefore.position && t.historical && !t.graph.isSimulationRunning &&
      JSON.stringify(t.snapshot().visible)===JSON.stringify(dockBefore.snapshot.visible) &&
      JSON.stringify(t.snapshot().positions)===JSON.stringify(dockBefore.snapshot.positions) &&
      JSON.stringify(calls)===JSON.stringify(dockBefore.calls) &&
      document.activeElement.id==='timeline-toggle' && document.getElementById('timeline-content').hidden`,
    `docking preserves cutoff, world positions, visibility and physics at ${width}×${height}`);
    await key('Tab', 'timeline-toggle');
    await check(`!document.getElementById('timeline-content').contains(document.activeElement) &&
      document.activeElement.getBoundingClientRect().height>0`, `Tab skips hidden timeline controls at ${width}×${height}`);
    await key('Enter', 'timeline-toggle'); await sleep(150);
    await check(`!document.getElementById('timeline-content').hidden && t.position===dockBefore.position &&
      parseFloat(document.querySelector('main').style.getPropertyValue('--timeline-height'))===dockBefore.height &&
      document.activeElement.id==='timeline-toggle'`, `keyboard undocking restores layout and keeps focus at ${width}×${height}`);
    await screenshot(`width-${width}`);
    await evaluate(`t.showInfo(undefined,false)`);
  }
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await evaluate(`t.setPosition(t.timeline.bins.length - 1)`);
  // Closing the compact card and changing the readout can resize the canvas.
  // Finish those deliberate layout changes before measuring touch isolation.
  await sleep(200);
  await evaluate(`document.getElementById('timeline-playhead').focus(); globalThis.touchPose = t.snapshot();
    globalThis.announcementPosts = 0; globalThis.announcementObserver = new MutationObserver(() => announcementPosts++);
    announcementObserver.observe(document.getElementById('timeline-announcement'), { childList: true });`);
  const rect = await evaluate(`(() => { const r = document.getElementById('timeline-histogram').getBoundingClientRect();
    return { left:r.left, width:r.width, y:r.top+r.height/2 }; })()`);
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.left + rect.width * .75, y: rect.y }] });
  // Sample across frames so Chromium can finish its native gesture recognition.
  for (let i = 0; i < 12; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: rect.left + rect.width * (.7 - i * .05), y: rect.y }] });
    await sleep(30);
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  const touchState = await evaluate(`({ before:touchPose.camera, after:t.snapshot().camera,
    beforeZoom:touchPose.zoom, afterZoom:t.graph.getZoomLevel(), announcementPosts,
    position:t.position, focus:document.activeElement.id })`);
  console.log('Touch isolation:', JSON.stringify(touchState));
  await check(`JSON.stringify(t.snapshot().camera) === JSON.stringify(touchPose.camera) &&
    t.graph.getZoomLevel() === touchPose.zoom && announcementPosts <= 3 &&
    t.position !== t.timeline.bins.length-1 && document.activeElement.id === 'timeline-playhead'`, 'touch scrubbing isolates the camera, retains focus and bounds announcements');
  for (const docked of [true, false]) {
    await evaluate(`globalThis.togglePose=t.snapshot(); globalThis.togglePosition=t.position`);
    const toggle = await evaluate(`(() => { const r=document.getElementById('timeline-toggle').getBoundingClientRect();
      return { x:r.left+r.width/2, y:r.top+r.height/2, width:r.width, height:r.height }; })()`);
    assert.equal(toggle.width, 44); assert.equal(toggle.height, 44);
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x:toggle.x, y:toggle.y }] });
    await sleep(60);
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(`document.getElementById('timeline-content').hidden===${docked}`);
    console.log('Touch toggle isolation:', JSON.stringify(await evaluate(`({ docked:document.getElementById('timeline-content').hidden,
      position:t.position, beforePosition:togglePosition, before:togglePose.camera, after:t.snapshot().camera,
      beforeZoom:togglePose.zoom, afterZoom:t.graph.getZoomLevel() })`)));
    await check(`document.getElementById('timeline-content').hidden===${docked} && t.position===togglePosition &&
      JSON.stringify(t.snapshot().camera)===JSON.stringify(togglePose.camera) && t.graph.getZoomLevel()===togglePose.zoom`,
    `touch ${docked ? 'docking' : 'undocking'} isolates the graph camera`);
  }
  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`t.setPosition(t.timeline.bins.length - 1); t.clearPhrase();
    t.graph.setZoomTransformByPointPositions(new Float32Array(t.graph.getPointPositions().slice(0,2)),0,1.25,.1,false);`);
  await sleep(200);
  await evaluate(`globalThis.beforeDrag = t.snapshot(); globalThis.startsBeforeDrag = calls.start;`);
  const point = await evaluate(`(() => { const g=t.graph, rect=document.getElementById('graph').getBoundingClientRect();
    const p=g.spaceToScreenPosition(g.getPointPositions().slice(0,2)); return [p[0]+rect.left,p[1]+rect.top]; })()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] }); await sleep(150);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 6; step++) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0] + step * 8, y: point[1] + step * 5, button: 'left', buttons: 1 });
    await sleep(30);
  }
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0] + 48, y: point[1] + 30, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(100);
  await check(`(() => { const after=t.snapshot(); const changed=t.selection.visibleIndices.filter(i =>
    after.positions[i*2] !== beforeDrag.positions[i*2] || after.positions[i*2+1] !== beforeDrag.positions[i*2+1]);
    return changed.length === 1 && calls.start === startsBeforeDrag && !after.running; })()`, 'explicit historical dragging moves one album without restarting map physics');
  await evaluate(`globalThis.dragPose=t.snapshot(); t.setPosition(-1); t.setPosition(t.timeline.bins.length-1)`);
  await check(`JSON.stringify(t.snapshot().positions) === JSON.stringify(dragPose.positions)`, 'scrubbing preserves the explicitly dragged album baseline');
  for (const mode of await evaluate(`[...document.getElementById('group').options].filter(option=>!option.disabled).map(option=>option.value)`)) {
    await evaluate(`t.setPosition(null)`); await input('group', mode, 'change');
    await evaluate(`t.setPosition(t.timeline.bins.length-1)`);
    await check(`document.getElementById('group').value === 'cluster' && document.getElementById('group').disabled`, `history switches ${mode} grouping to communities`);
    await evaluate(`t.setPosition(null)`);
    await check(`document.getElementById('group').value === ${JSON.stringify(mode)} && !document.getElementById('group').disabled`, `Latest restores ${mode} grouping`);
  }
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await check(`getComputedStyle(document.getElementById('timeline-latest')).transitionDuration === '0s'`, 'reduced motion suppresses control transitions');
  await evaluate(`document.getElementById('timeline-toggle').click()`);
  await check(`document.getElementById('timeline-content').hidden &&
    getComputedStyle(document.getElementById('timeline')).transitionDuration==='0s'`, 'reduced motion docks immediately');
  await evaluate(`document.getElementById('timeline-toggle').click()`);
  await evaluate(`announcementObserver.disconnect(); t.setPosition(null); t.clearPhrase();
    globalThis.originalExport = structuredClone(t.data); globalThis.legacyExport = structuredClone(t.data);
    legacyExport.albums.forEach(album => delete album.added);
    document.getElementById('timeline-playhead').value=0;
    document.getElementById('timeline-playhead').dispatchEvent(new Event('input', {bubbles:true}));
    t.load(legacyExport, 'Legacy fixture');`);
  await wait(`!document.getElementById('search').disabled && t.timeline.bins.length === 0`);
  await check(`t.position === null && !t.historical && !document.getElementById('timeline-empty').hidden &&
    t.selection.visibleIndices.length === t.data.albums.length && !document.getElementById('group').disabled`, 'reload clears history and legacy exports leave the graph unrestricted');
  await evaluate(`document.getElementById('timeline-toggle').click()`);
  await check(`document.getElementById('timeline-content').hidden && document.getElementById('timeline-compact').textContent==='Latest'`, 'legacy exports keep a safe compact Latest readout when docked');
  await evaluate(`t.load(originalExport, 'Dated fixture')`);
  await wait(`!document.getElementById('timeline-playhead').disabled`);
  await check(`t.position === null && t.timeline.bins.length > 0 && !t.historical`, 'dated reload rebuilds bins and resets pending state');
  await check(`document.getElementById('timeline-content').hidden`, 'loading a new export preserves the docking choice');
  await evaluate(`document.getElementById('timeline-toggle').click()`);
  await evaluate(`globalThis.lensExport=structuredClone(t.data);
    lensExport.labels.push({id:'timeline:test',label:'Timeline test lens',source:'essentia',kind:'probability',min:0,max:1,
      scores:btoa(lensExport.albums.map((_,i)=>String.fromCharCode(i%2?1:255)).join(''))});
    t.load(lensExport,'Lens fixture');`);
  await wait(`!document.getElementById('search').disabled && t.data.labels.some(label=>label.id==='timeline:test')`);
  await evaluate(`t.setPosition(t.timeline.bins.length-1)`);
  await input('lens', 'Timeline test lens [essentia]');
  await check(`t.selection.visibleIndices.length>0 && t.selection.visibleIndices.every(i=>i%2===0&&Number.isFinite(t.timeline.dates[i])) &&
    t.labels.every(label=>label.indices.every(i=>t.selection.states[i].visible))`, 'lens eligibility and community labels compose with history');
  await evaluate(`document.getElementById('clear-lens').click()`);
  await check(`t.historical && t.selection.visibleIndices.length===t.timeline.total-t.timeline.undated`, 'clearing the lens preserves the cutoff');
  await input('vocal', 'voice');
  await check(`t.selection.visibleIndices.every(i=>t.data.albums[i].essentia?.voice_instrumental?.value==='voice'&&Number.isFinite(t.timeline.dates[i]))`, 'sound filters cannot reveal future or undated albums');

  const bookmarkFixture = JSON.parse(await readFile(new URL('./fixtures/timeline-bookmarks.json', import.meta.url), 'utf8'));
  await evaluate(`t.load(originalExport, 'No bookmarks fixture')`);
  await wait(`!document.getElementById('search').disabled && !document.getElementById('timeline-playhead').disabled`);
  await sleep(150);
  await check(`document.getElementById('timeline-bookmarks').hidden && !document.querySelector('.timeline-bookmark')`,
    'exports without bookmarks retain an empty hidden bookmark strip');
  await evaluate(`globalThis.noBookmarkHeight=document.getElementById('timeline').getBoundingClientRect().height;
    t.load({...structuredClone(originalExport), ...${JSON.stringify(bookmarkFixture)}}, 'Life-event fixture');`);
  await wait(`!document.getElementById('search').disabled && !document.getElementById('timeline-playhead').disabled && t.timeline.bookmarks.length===11`);
  await sleep(150);
  await check(`document.querySelectorAll('.timeline-bookmark').length===11 &&
    document.querySelectorAll('.timeline-bookmark-range').length===2 &&
    document.querySelectorAll('.timeline-bookmark.approximate').length===6`,
    'valid fixture events, ranges and approximate precisions render while malformed entries are ignored');
  await check(`t.timeline.bins[0].start===Date.parse('2023-09-01T00:00:00Z') &&
    t.timeline.bins.at(-1).end>Date.parse('2027-01-01T00:00:00Z')`, 'life events extend both ends of the album timeline');
  await evaluate(`globalThis.focusedBookmark=document.querySelectorAll('.timeline-bookmark')[6]; focusedBookmark.focus()`);
  await call('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
  await sleep(200);
  await check(`(() => { const rect=focusedBookmark.getBoundingClientRect(),
    scroll=document.querySelector('.timeline-bookmark-scroll').getBoundingClientRect();
    return document.activeElement===focusedBookmark && rect.top>=scroll.top-.5 && rect.bottom<=scroll.bottom+.5;
  })()`, 'resizing to mobile keeps the same bookmark focused and scrolls its new lane into view');

  for (const [width, height] of [[1440,1000], [390,844]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:width<761 });
    await sleep(200);
    await evaluate(`t.setPosition(null); t.graph.pause(); globalThis.bookmarkPose=t.snapshot();
      globalThis.importIndex=t.timeline.bookmarks.findIndex(b=>b.id==='beets-library-import');
      document.querySelectorAll('.timeline-bookmark')[importIndex].focus();`);
    await key('Enter', null);
    await check(`t.position===t.timeline.bins.findIndex(bin=>Date.parse('2024-02-29T00:00:00Z')>=bin.start&&Date.parse('2024-02-29T00:00:00Z')<bin.end) &&
      document.activeElement===document.querySelectorAll('.timeline-bookmark')[importIndex] &&
      t.selection.visibleIndices.length===1 && !t.graph.isSimulationRunning &&
      JSON.stringify(t.snapshot().camera)===JSON.stringify(bookmarkPose.camera) &&
      t.selection.visibleIndices.every(i=>t.snapshot().positions[i*2]===bookmarkPose.positions[i*2]&&
        t.snapshot().positions[i*2+1]===bookmarkPose.positions[i*2+1]) &&
      document.getElementById('timeline-announcement').textContent.includes('Library imported into beets')`,
      `bookmark Enter selects its snapshot, preserves focus and freezes the map at ${width}px`);
    await evaluate(`globalThis.escapedIndex=t.timeline.bookmarks.findIndex(b=>b.id==='escaped');
      document.querySelectorAll('.timeline-bookmark')[escapedIndex].focus();`);
    await key(' ', null);
    await check(`document.getElementById('timeline-bookmark-label').textContent===
      document.querySelectorAll('.timeline-bookmark')[escapedIndex].getAttribute('aria-label') &&
      document.getElementById('timeline-bookmark-label').textContent.includes('<img src=x') &&
      !document.getElementById('timeline-bookmark-label').children.length &&
      !document.querySelector('#timeline-bookmarks img') && !globalThis.bookmarkInjected`,
      `Space activation and hostile titles remain accessible literal text at ${width}px`);
    await check(`(() => {
      const scroll=document.querySelector('.timeline-bookmark-scroll').getBoundingClientRect(),
        tooltip=document.getElementById('timeline-bookmark-label').getBoundingClientRect();
      return scroll.height<=88 && tooltip.left>=0 && tooltip.right<=innerWidth &&
        tooltip.bottom<=document.getElementById('timeline').getBoundingClientRect().top &&
        document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.timeline-bookmark')].every(marker=> {
          marker.focus(); const rect=marker.getBoundingClientRect();
          return rect.width===44 && rect.height===44 && rect.left>=scroll.left && rect.right<=scroll.right+.5 &&
            rect.top>=scroll.top-.5 && rect.bottom<=scroll.bottom+.5;
        }); })()`, `overlapping bookmark targets scroll into reach without horizontal overflow at ${width}px`);
    await check(`(() => { const markers=[...document.querySelectorAll('.timeline-bookmark')];
      return markers.every((marker,i)=>markers.slice(i+1).every(other=> {
        const a=marker.getBoundingClientRect(),b=other.getBoundingClientRect();
        return a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top;
      })); })()`, `bookmark hit areas never overlap at ${width}px`);
    await evaluate(`document.querySelectorAll('.timeline-bookmark')[escapedIndex].focus()`);
    await screenshot(`bookmarks-${width}`);
    await key('Escape', null);
    await check(`t.position===null && document.getElementById('timeline-bookmark-label').hidden`,
      `bookmark Escape restores Latest and dismisses the tooltip at ${width}px`);
    await evaluate(`document.querySelectorAll('.timeline-bookmark')[0].focus()`);
    await key(' ', 'timeline-toggle');
    await check(`document.getElementById('timeline-content').hidden && document.getElementById('timeline-bookmark-label').hidden`,
      `docking hides bookmark controls and labels at ${width}px`);
    await key('Tab', 'timeline-toggle');
    await check(`!document.getElementById('timeline-bookmarks').contains(document.activeElement)`,
      `Tab skips docked bookmarks at ${width}px`);
    await key('Enter', 'timeline-toggle');
  }

  await call('Emulation.setDeviceMetricsOverride', { width:1440, height:1000, deviceScaleFactor:1, mobile:false });
  for (const value of [[], [null, {id:'malformed'}]]) {
    await evaluate(`t.load({...structuredClone(originalExport), bookmarks:${JSON.stringify(value)}}, 'Empty bookmarks fixture')`);
    await wait(`!document.getElementById('search').disabled && !document.getElementById('timeline-playhead').disabled`); await sleep(150);
    await check(`document.getElementById('timeline-bookmarks').hidden && !document.querySelector('.timeline-bookmark') &&
      document.getElementById('timeline-bookmark-label').hidden &&
      document.getElementById('timeline').getBoundingClientRect().height===noBookmarkHeight`,
      'empty or malformed bookmarks restore the exact original tray height and clear old controls');
  }
  await evaluate(`globalThis.bookmarkOnlyExport=structuredClone(originalExport);
    bookmarkOnlyExport.albums.forEach(album=>delete album.added);
    bookmarkOnlyExport.bookmarks=${JSON.stringify(bookmarkFixture.bookmarks)};
    t.load(bookmarkOnlyExport,'Events with undated albums');`);
  await wait(`!document.getElementById('search').disabled && !document.getElementById('timeline-playhead').disabled && t.timeline.bookmarks.length===11`);
  await evaluate(`document.querySelectorAll('.timeline-bookmark')[0].focus()`);
  await key('Enter', null);
  await check(`t.timeline.maxCount===0 && t.selection.visibleIndices.length===0 &&
    document.getElementById('timeline-readout').textContent.includes('Snapshot 0 /')`,
    'bookmark-only dates render safely and historical snapshots exclude undated albums');
  assert.deepEqual(exceptions, [], 'no browser exceptions or console errors');
  console.log(JSON.stringify({ result: 'PASS', checks }, null, 2));
} finally {
  if (previousDockPreference !== undefined) await evaluate(previousDockPreference === null ?
    `localStorage.removeItem(${dockKey})` : `localStorage.setItem(${dockKey}, ${JSON.stringify(previousDockPreference)})`).catch(() => {});
  clearTimeout(deadline); socket.close();
  await fetch(`${cdp}/json/close/${target.id}`);
}

import assert from 'node:assert/strict';

// Runs inside the existing Chromium/CDP harness with test-local camera hooks.
export async function mobileInteractionChecks({ call, evaluate, check, wait, sleep }) {
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await evaluate(`t.setPosition(null); t.showInfo(undefined, false);
    if (!document.getElementById('timeline-content').hidden) document.querySelector('.map-toolbar #timeline-toggle').click();
    if (document.getElementById('pause').getAttribute('aria-pressed') !== 'true') document.getElementById('pause').click();
    document.getElementById('show-labels').checked=false;
    document.getElementById('show-labels').dispatchEvent(new Event('change'));
    t.graph.fitView(0,.08,false);`);
  await sleep(250);
  await check(`document.querySelector('meta[name=viewport]').content.includes('maximum-scale=1') &&
    document.querySelector('meta[name=viewport]').content.includes('user-scalable=no') &&
    document.querySelector('meta[name=viewport]').content.includes('viewport-fit=cover')`, 'full-screen viewport ships the approved scaling restriction');
  await check(`getComputedStyle(document.body).touchAction === 'pan-x pan-y' &&
    getComputedStyle(document.querySelector('.map-bottom')).touchAction === 'pan-x pan-y' &&
    getComputedStyle(document.querySelector('#graph canvas')).touchAction === 'none'`, 'app excludes browser pinch while graph owns all gestures');
  await check(`document.querySelector('.map-bottom .map-toolbar #timeline-toggle') &&
    document.getElementById('timeline-content').hidden && document.getElementById('timeline').hidden`,
    'mobile gesture checks start with the tray closed and the toggle in the bottom toolbar');
  await check(`[...document.querySelectorAll('input[type=search]')].every(input=>parseFloat(getComputedStyle(input).fontSize)>=16)`, 'all mobile search fields avoid focus auto-zoom');
  await check(`(() => { const event=new Event('gesturestart',{bubbles:true,cancelable:true});
    document.getElementById('search').dispatchEvent(event); return event.defaultPrevented; })()`, 'Safari gesture cancellation covers viewer chrome');
  const touch = async (type, points, ids = points.map((_, i) => i + 11)) => {
    await call('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, index) =>
      ({ x: point[0], y: point[1], id: ids[index] })) });
    await sleep(25);
    assert.equal(await evaluate('window.visualViewport.scale'), 1, 'page remains at 1x throughout touch input');
  };
  const center = async selector => evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)});
    const r=element.getBoundingClientRect();
    if (!r.width || !r.height || r.top<0 || r.bottom>innerHeight) throw new Error('Touch target outside viewport: '+${JSON.stringify(selector)});
    return [r.left+r.width/2,r.top+r.height/2]; })()`);
  async function pinch(selector, label, customCenter) {
    const [x, y] = customCenter ?? await center(selector);
    await evaluate(`globalThis.pinchBefore=t.snapshot(); globalThis.pinchAnchor=t.graph.screenToSpacePosition(
      [${x}-t.graph.canvas.getBoundingClientRect().left,${y}-t.graph.canvas.getBoundingClientRect().top]);`);
    await touch('touchStart', [[x - 8, y]]);
    await touch('touchStart', [[x - 8, y], [x + 8, y]]);
    for (let step = 1; step <= 5; step++) {
      const spread = 8 + step * 1.6;
      await touch('touchMove', [[x - spread + step, y + step], [x + spread + step, y + step]]);
    }
    await touch('touchEnd', []);
    await check(`Math.abs(t.graph.getZoomLevel()/pinchBefore.zoom-2)<.02 &&
      t.graph.screenToSpacePosition([${x + 5}-t.graph.canvas.getBoundingClientRect().left,
        ${y + 5}-t.graph.canvas.getBoundingClientRect().top]).every((value,i)=>Math.abs(value-pinchAnchor[i])<.5)`,
    `${label} pinch forwards scale and midpoint movement to the graph at page scale 1`);
  }
  const graphCenter = await evaluate(`(() => { const r=t.graph.canvas.getBoundingClientRect(); return [r.left+r.width/2,r.top+100]; })()`);
  await pinch('#graph canvas', 'graph', graphCenter);
  await pinch('#search', 'search input');
  const searchCenter = await center('#search');
  for (const graphFirst of [true, false]) {
    const before = graphFirst ? [graphCenter, searchCenter] : [searchCenter, graphCenter];
    const middle = [(before[0][0]+before[1][0])/2,(before[0][1]+before[1][1])/2];
    const after = before.map(point=>point.map((value,i)=>middle[i]+(value-middle[i])*1.4));
    await evaluate(`globalThis.mixedZoom=t.graph.getZoomLevel()`);
    await touch('touchStart', [before[0]]); await touch('touchStart', before); await touch('touchMove', after);
    await check(`Math.abs(t.graph.getZoomLevel()/mixedZoom-1.4)<.02`, `mixed overlay/graph pinch forwards in ${graphFirst ? 'graph' : 'overlay'}-first order`);
    // Chromium's WebTouch backend releases the listed contact. Its newer
    // synthetic-pointer backend instead releases contacts omitted from a move.
    try { await touch('touchEnd', [after[1]], [12]); }
    catch (error) {
      if (!error.message.includes('TouchEnd and TouchCancel must not have any touch points')) throw error;
      await touch('touchMove', [after[0]]);
    }
    await evaluate(`globalThis.remainingPose=t.snapshot()`);
    await touch('touchMove', [[after[0][0]+15,after[0][1]+10]]);
    await check(`t.graph.getZoomLevel()===remainingPose.zoom &&
      (JSON.stringify(t.snapshot().camera)${graphFirst ? '!==' : '==='}JSON.stringify(remainingPose.camera))`,
    `${graphFirst ? 'graph' : 'overlay'}-origin pinch ${graphFirst ? 'pans with' : 'swallows'} the remaining finger`);
    await touch('touchEnd', []);
  }
  await evaluate(`document.getElementById('search').focus()`);
  await check(`visualViewport.scale===1 && document.activeElement.id==='search'`, 'search focus keeps page scale 1');
  await evaluate(`document.getElementById('search').blur(); document.getElementById('settings-toggle').click();`);
  await wait(`document.body.classList.contains('settings-open')`);
  await pinch('#library-count', 'stats line');
  await pinch('#controls h1', 'controls panel');
  await evaluate(`document.getElementById('settings-toggle').click()`);
  await wait(`!document.body.classList.contains('settings-open')`);
  for (const open of [false, true]) {
    await evaluate(`if(document.getElementById('timeline-content').hidden===${open}) document.querySelector('.map-toolbar #timeline-toggle').click()`);
    await sleep(150);
    await evaluate(`globalThis.bottomBeforePinch=['.map-bottom','.map-footer','.map-toolbar'].map(selector=>{
      const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height]; });`);
    await pinch('.map-toolbar #timeline-toggle', `docked timeline toggle with tray ${open ? 'open' : 'closed'}`);
    await pinch('.map-bottom', `shared bottom container with tray ${open ? 'open' : 'closed'}`);
    await pinch('.map-bottom #status', `bottom stats line with tray ${open ? 'open' : 'closed'}`);
    await check(`document.getElementById('timeline-content').hidden===${!open} &&
      document.getElementById('timeline').hidden===${!open} &&
      JSON.stringify(['.map-bottom','.map-footer','.map-toolbar'].map(selector=>{
        const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height]; }))===JSON.stringify(bottomBeforePinch)`,
    `bottom chrome pinches preserve the ${open ? 'open' : 'closed'} tray and docked layout`);
  }
  await pinch('.timeline-heading strong', 'open timeline tray');

  // First finger already owns a custom scrub capture when the second arrives.
  const histogram = await center('#timeline-histogram');
  await touch('touchStart', [[histogram[0] - 8, histogram[1]]]);
  await touch('touchStart', [[histogram[0] - 8, histogram[1]], [histogram[0] + 8, histogram[1]]]);
  const cutoff = await evaluate(`t.position`);
  await touch('touchMove', [[histogram[0] - 20, histogram[1]], [histogram[0] + 20, histogram[1]]]);
  await touch('touchEnd', []);
  assert.equal(await evaluate(`t.position`), cutoff, 'pinch takeover cancels pending timeline scrub updates');

  await evaluate(`t.setPosition(null); t.showInfo(undefined,false);
    if(!document.getElementById('timeline-content').hidden) document.getElementById('timeline-toggle').click();
    t.graph.setZoomTransformByPointPositions(new Float32Array(t.graph.getPointPositions().slice(0,2)),0,1.25,.1,false);`);
  await sleep(200);
  const node = await evaluate(`(() => { const r=t.graph.canvas.getBoundingClientRect();
    const p=t.graph.spaceToScreenPosition(t.graph.getPointPositions().slice(0,2)); return [p[0]+r.left,p[1]+r.top]; })()`);
  await touch('touchStart', [node]); await touch('touchEnd', []);
  await wait(`t.selected===0 && !document.getElementById('details').hidden`);
  await check(`t.selected===0`, 'touching an album still selects it');
  await pinch('#details h2', 'album details panel');

  // Make panel content overflow without changing product layout or fixtures.
  // Real single-finger scrolling must remain native and leave the camera alone.
  for (const [selector, parent] of [['#details', '#info'], ['.timeline-bookmark-scroll', '.timeline-bookmark-track']]) {
    if (selector.includes('timeline')) {
      await evaluate(`if(document.getElementById('timeline-content').hidden) document.getElementById('timeline-toggle').click();
        document.getElementById('timeline-bookmarks').hidden=false;`);
    }
    await evaluate(`(() => { const filler=document.createElement('div'); filler.id='gesture-scroll-fixture';
      filler.style.height='800px'; document.querySelector(${JSON.stringify(parent)}).append(filler);
      document.querySelector(${JSON.stringify(selector)}).scrollTop=0; })()`);
    await sleep(150);
    const region = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return [r.left+r.width*.8,r.top+r.height*.8,r.height]; })()`);
    await evaluate(`globalThis.scrollCamera=t.snapshot()`);
    await touch('touchStart', [[region[0], region[1]]]);
    for (let step = 1; step <= 6; step++) await touch('touchMove', [[region[0], region[1] - Math.min(region[2] * .5, 70) * step / 6]]);
    // A second finger arriving after native scrolling may only be swallowed.
    await touch('touchStart', [[region[0], region[1] - Math.min(region[2] * .5, 70)], [region[0] - 20, region[1]]]);
    await touch('touchMove', [[region[0] + 10, region[1] - Math.min(region[2] * .5, 70)], [region[0] - 30, region[1]]]);
    await touch('touchEnd', []); await sleep(100);
    await check(`document.querySelector(${JSON.stringify(selector)}).scrollTop>0 &&
      t.graph.getZoomLevel()===scrollCamera.zoom && JSON.stringify(t.snapshot().camera)===JSON.stringify(scrollCamera.camera)`,
    `${selector} retains single-finger scrolling and swallows pinch after native scroll takeover`);
    await evaluate(`document.getElementById('gesture-scroll-fixture').remove()`);
  }
  await evaluate(`t.showInfo(undefined,false);
    if(!document.getElementById('timeline-content').hidden) document.getElementById('timeline-toggle').click();
    t.graph.setZoomTransformByPointPositions(new Float32Array(t.graph.getPointPositions().slice(0,2)),0,1.25,.1,false);`);
  await sleep(200);
  const dragNode = await evaluate(`(() => { const r=t.graph.canvas.getBoundingClientRect();
    const p=t.graph.spaceToScreenPosition(t.graph.getPointPositions().slice(0,2)); return [p[0]+r.left,p[1]+r.top]; })()`);
  await evaluate(`globalThis.dragBefore=t.snapshot()`);
  await touch('touchStart', [dragNode]);
  for (let step = 1; step <= 5; step++) await touch('touchMove', [[dragNode[0] + step * 8, dragNode[1] + step * 4]]);
  await touch('touchEnd', []);
  await check(`t.graph.getPointPositions()[0]!==dragBefore.positions[0] &&
    t.graph.getZoomLevel()===dragBefore.zoom && t.selected===undefined && !t.graph.isSimulationRunning`,
    'one-finger album drag moves the album without selecting or restarting paused physics');
  const dragEnd = [dragNode[0] + 40, dragNode[1] + 20];
  await touch('touchStart', [dragEnd]);
  await touch('touchMove', [[dragEnd[0] + 10, dragEnd[1]]]);
  await evaluate(`globalThis.handoffNode=Array.from(t.graph.getPointPositions().slice(0,2)); globalThis.handoffZoom=t.graph.getZoomLevel()`);
  await touch('touchStart', [[dragEnd[0] + 10, dragEnd[1]], [dragEnd[0] + 60, dragEnd[1]]]);
  await touch('touchMove', [[dragEnd[0], dragEnd[1]], [dragEnd[0] + 70, dragEnd[1]]]);
  await touch('touchEnd', []);
  await check(`t.graph.getZoomLevel()>handoffZoom && t.graph.getPointPositions().slice(0,2).every((v,i)=>v===handoffNode[i])`,
    'second finger immediately hands album dragging to graph pinch');
  // Empty corner avoids node picking and tests ordinary graph pan and double tap.
  const corner = await evaluate(`(() => { const r=t.graph.canvas.getBoundingClientRect();return [r.left+10,r.top+10];})()`);
  await evaluate(`globalThis.panBefore=t.snapshot()`);
  await touch('touchStart', [corner]); await touch('touchMove', [[corner[0] + 40, corner[1] + 25]]); await touch('touchEnd', []);
  await check(`t.graph.getZoomLevel()===panBefore.zoom && JSON.stringify(t.snapshot().camera)!==JSON.stringify(panBefore.camera)`, 'one-finger background drag pans the graph');
  for (let i = 0; i < 2; i++) { await touch('touchStart', [corner]); await touch('touchEnd', []); }
  await check(`visualViewport.scale===1`, 'graph double tap cannot enlarge the page');
  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  const wheelPoint = await evaluate(`(() => { const r=t.graph.canvas.getBoundingClientRect();return [r.left+100,r.top+100];})()`);
  await evaluate(`globalThis.wheelZoom=t.graph.getZoomLevel()`);
  await call('Input.dispatchMouseEvent', { type:'mouseWheel', x:wheelPoint[0], y:wheelPoint[1], deltaX:0, deltaY:-100 });
  await sleep(200);
  await check(`t.graph.getZoomLevel()>wheelZoom && visualViewport.scale===1`, 'desktop wheel zoom remains available after touch interaction');
}

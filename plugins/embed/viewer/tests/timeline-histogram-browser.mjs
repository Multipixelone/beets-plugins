import assert from 'node:assert/strict';

// Shared-scale and interaction acceptance checks. Bookmark interaction and
// collision tests stay with the rail owner; this checks only anchor alignment.
export async function timelineAlignmentChecks({ evaluate, check }, label) {
  await check(`(() => {
    const geometry=t.geometry, stage=document.getElementById('timeline-stage'), rect=stage.getBoundingClientRect();
    const client=time=>geometry.contentToClientX(geometry.xForTime(time),rect,stage.scrollLeft);
    const close=(a,b)=>Math.abs(a-b)<=1;
    const ticks=[...document.querySelectorAll('#timeline-axis [data-time]')];
    if (!ticks.every(tick=>{ const r=tick.getBoundingClientRect();
      const anchor=tick.classList.contains('first')?r.left:tick.classList.contains('last')?r.right:r.left+r.width/2;
      return close(anchor,client(Number(tick.dataset.time))); })) return false;
    const range=document.getElementById('timeline-playhead'), r=range.getBoundingClientRect(), value=Number(range.value);
    const center=r.left+geometry.thumbInset+(value-Number(range.min))/(Number(range.max)-Number(range.min))*(r.width-2*geometry.thumbInset);
    if (!close(center,client(value))) return false;
    if (t.cutoff!==null&&!close(document.getElementById('timeline-selection').getBoundingClientRect().left,client(t.cutoff))) return false;
    if (![...document.querySelectorAll('#timeline-bookmarks .ag-bookmark-anchor[data-bookmark-id]')].every(marker=> {
      const bookmark=t.timeline.bookmarks.find(bookmark=>bookmark.id===marker.dataset.bookmarkId), r=marker.getBoundingClientRect();
      return bookmark&&close(r.left+r.width/2,client(bookmark.start));
    })) return false;
    if (![...document.querySelectorAll('#timeline-bookmarks .ag-bookmark-span')].every(span=> {
      const start=span.getPointAtLength(0).matrixTransform(span.getScreenCTM());
      const end=span.getPointAtLength(span.getTotalLength()).matrixTransform(span.getScreenCTM());
      return t.timeline.bookmarks.some(bookmark=>bookmark.end!==null&&close(start.x,client(bookmark.start))&&close(end.x,client(bookmark.end+86400000)));
    })) return false;
    // Inspect the actual drawing calls, rather than restating the geometry.
    const context=document.getElementById('timeline-histogram').getContext('2d'), fill=context.fillRect;
    const bars=[]; context.fillRect=function(...args){ bars.push(args); return fill.apply(this,args); };
    try { t.view.draw(); } finally { context.fillRect=fill; }
    let bar=0;
    return t.segments.every((segments,index)=>segments.every(segment=> {
      const actual=bars[bar++], bin=t.timeline.bins[index];
      return close(actual[0]-1,geometry.xForTime(bin.start)) &&
        close(actual[0]+actual[2]+1,geometry.xForTime(bin.end));
    }));
  })()`, label);
}

export async function timelineBookmarkIntegrationChecks({ call, evaluate, check, wait, sleep, key, screenshot, bookmarkFixture, originalExport }) {
  await evaluate(`t.load({...${JSON.stringify(originalExport)}, ...${JSON.stringify(bookmarkFixture)}},'Integrated important dates')`);
  await wait(`!document.getElementById('search').disabled&&!document.getElementById('timeline-playhead').disabled&&t.timeline.bookmarks.length===12`);
  await evaluate(`if(document.getElementById('timeline-content').hidden) document.getElementById('timeline-toggle').click(); t.graph.pause();`);
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height:width===390?844:1000, deviceScaleFactor:1, mobile:width===390 });
    await sleep(200);
    await check(`document.querySelector('.ag-bookmark-rail')&&document.querySelector('.ag-bookmark-target')&&
      !document.querySelector('.timeline-bookmark-scroll')&&document.querySelector('.ag-bookmark-tooltip').parentElement.id==='timeline-tooltip-layer'&&
      t.timeline.bins.reduce((sum,bin)=>sum+bin.count,0)===t.timeline.total-t.timeline.undated&&
      t.timeline.bins[0].start<=t.timeline.bookmarks[0].start&&t.timeline.bins.at(-1).end>t.timeline.bookmarks.at(-1).start`,
      `${width}px important dates mount above the chart, extend its domain and contribute no album counts`);
    for (const part of [0,.5,1]) {
      await evaluate(`document.getElementById('timeline-stage').scrollLeft=(t.geometry.contentWidth-document.getElementById('timeline-stage').clientWidth)*${part}`);
      await sleep(30);
      await timelineAlignmentChecks({ evaluate, check }, `${width}px event anchors and range endpoints align with chart geometry after ${part} scroll`);
    }
    await evaluate(`t.setCutoff(t.timeline.bins[0].start);
      globalThis.clusterPin=document.querySelector('.ag-bookmark-target[aria-haspopup=dialog]');
      clusterPin.scrollIntoView({block:'nearest',inline:'nearest'}); clusterPin.focus();
      globalThis.clusterCutoff=t.cutoff; globalThis.clusterPose=t.snapshot();`);
    await key('Enter', null);
    await check(`!document.querySelector('.ag-bookmark-list').hidden&&document.activeElement.classList.contains('ag-bookmark-entry')&&t.cutoff===clusterCutoff`,
      `${width}px opening an event list previews dates without changing the snapshot`);
    await check(`(() => { const entry=document.activeElement, id=entry.dataset.bookmarkId,
      bookmark=t.timeline.bookmarks.find(bookmark=>bookmark.id===id), tooltip=document.querySelector('.ag-bookmark-tooltip'), r=tooltip.getBoundingClientRect();
      return t.view.guideTime===bookmark.start&&!tooltip.hidden&&tooltip.textContent.includes(bookmark.date)&&
        r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&
        JSON.stringify(t.snapshot().camera)===JSON.stringify(clusterPose.camera);
    })()`, `${width}px an individual event previews its exact date guide and readable viewport tooltip`);
    await key('Escape', null);
    await check(`document.querySelector('.ag-bookmark-list').hidden&&t.cutoff===clusterCutoff&&document.activeElement===clusterPin`,
      `${width}px first Escape closes the event list and retains history`);
    await key('Escape', null);
    await check(`t.cutoff===null&&!document.getElementById('group').disabled&&document.activeElement===clusterPin&&document.querySelector('.ag-bookmark-tooltip').hidden`,
      `${width}px second Escape reaches the timeline, restores Latest and preserves pin focus`);
    await key('Enter', null);
    await evaluate(`globalThis.eventId=document.activeElement.dataset.bookmarkId;
      globalThis.eventCutoff=t.timeline.bookmarks.find(bookmark=>bookmark.id===eventId).start+86400000;
      globalThis.eventPose=t.snapshot();`);
    await key('Enter', null);
    await check(`t.cutoff===eventCutoff&&t.historical&&!t.graph.isSimulationRunning&&document.querySelector('.ag-bookmark-list').hidden&&
      t.selection.visibleIndices.length===t.timeline.dates.filter(date=>Number.isFinite(date)&&date<eventCutoff).length&&
      t.selection.visibleIndices.every(index=>t.timeline.dates[index]<eventCutoff)&&
      JSON.stringify(t.snapshot().camera)===JSON.stringify(eventPose.camera)&&
      t.selection.visibleIndices.every(index=>t.snapshot().positions[index*2]===eventPose.positions[index*2]&&t.snapshot().positions[index*2+1]===eventPose.positions[index*2+1])`,
      `${width}px event activation uses an exclusive next-day cutoff with stable cumulative graph membership and pose`);
    await evaluate(`globalThis.focusedPin=document.activeElement; globalThis.pinCutoff=t.cutoff;`);
    await call('Emulation.setDeviceMetricsOverride', { width:width===390?1440:390, height:width===390?1000:844, deviceScaleFactor:1, mobile:width!==390 });
    await sleep(200);
    await check(`document.activeElement===focusedPin&&t.cutoff===pinCutoff`, `${width}px pin focus and exact cutoff survive resize`);
    await evaluate(`document.getElementById('timeline-toggle').click()`);
    await check(`!document.querySelector('.ag-bookmark-tooltip')&&!document.querySelector('.ag-bookmark-list')&&!document.querySelector('.ag-bookmark-rail')&&t.cutoff===pinCutoff`,
      `${width}px docking unmounts the rail and viewport overlays while retaining the snapshot`);
    await evaluate(`document.getElementById('timeline-toggle').click()`); await sleep(100);
    await check(`document.querySelector('.ag-bookmark-rail')&&t.cutoff===pinCutoff`, `${width}px reopening mounts the current rail without resetting history`);
    await call('Emulation.setDeviceMetricsOverride', { width, height:width===390?844:1000, deviceScaleFactor:1, mobile:width===390 });
    await sleep(150);
    await check(`(() => { const main=document.querySelector('main'), tray=document.getElementById('timeline');
      return main.scrollTop===0&&tray.getBoundingClientRect().top>=main.getBoundingClientRect().top&&
        tray.getBoundingClientRect().bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth; })()`,
      `${width}px rail and chart remain inside the map without scrolling the page`);
    await screenshot(`rail-${width}`);
  }
  await evaluate(`globalThis.bookmarkOnly=structuredClone(t.data);
    bookmarkOnly.albums.forEach(album=>{delete album.added;delete album.first_played;delete album.first_played_source});
    t.load(bookmarkOnly,'Important dates with undated albums');`);
  await wait(`!document.getElementById('search').disabled&&t.timeline.maxCount===0&&t.timeline.bookmarks.length===12`);
  await evaluate(`t.setCutoff(t.timeline.bins.at(-1).end)`);
  await check(`!t.selection.visibleIndices.length&&t.aggregation.scale.max===3&&document.querySelector('.ag-bookmark-rail')&&
    document.getElementById('timeline-bin-summary').textContent.includes('0 albums')`, 'bookmark-only history retains the rail, zero count scale and empty historical membership');
  await timelineAlignmentChecks({ evaluate, check }, 'bookmark-only anchors, ranges, calendar ticks and thumb share the same coordinates');
  await evaluate(`t.setCutoff(null)`);
  await check(`t.selection.visibleIndices.length===t.timeline.total`, 'Latest includes all undated albums in a bookmark-only export');
  await evaluate(`t.load(${JSON.stringify(originalExport)},'Reload without important dates')`);
  await wait(`!document.getElementById('search').disabled&&!document.getElementById('timeline-playhead').disabled`);
  await check(`document.getElementById('timeline-bookmarks').hidden&&!document.querySelector('.ag-bookmark-target')&&
    document.querySelector('.ag-bookmark-tooltip').hidden&&document.querySelector('.ag-bookmark-list').hidden&&t.cutoff===null`,
    'reload clears stale rail controls, overlays and historical cutoff');
}

export async function timelineHistogramChecks({ call, evaluate, check, wait, sleep, key, screenshot }) {
  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`globalThis.histogramOriginal=structuredClone(t.data);
    globalThis.longHistory=structuredClone(t.data);
    longHistory.albums.forEach((album,index)=> {
      delete album.added; delete album.first_played_source;
      const month=Math.round(index/(longHistory.albums.length-1)*119);
      album.first_played=new Date(Date.UTC(2014,month,1)).toISOString().slice(0,10);
    });
    delete longHistory.bookmarks;
    t.load(longHistory,'Ten-year timeline fixture');`);
  await wait(`!document.getElementById('search').disabled && !document.getElementById('timeline-playhead').disabled && t.timeline.bins.length===120`);
  await evaluate(`if(document.getElementById('timeline-content').hidden) document.getElementById('timeline-toggle').click();
    t.graph.pause(); t.setCutoff(t.timeline.bins[60].end);
    document.getElementById('timeline-playhead').focus();
    globalThis.historyInvariant=JSON.stringify({ bins:t.timeline.bins, scale:t.aggregation.scale,
      majors:t.aggregation.majorCommunities, stacks:t.segments, cutoff:t.cutoff, visible:t.selection.visibleIndices });`);
  for (const width of [1440, 390, 1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await sleep(200);
    await check(`historyInvariant===JSON.stringify({ bins:t.timeline.bins, scale:t.aggregation.scale,
      majors:t.aggregation.majorCommunities, stacks:t.segments, cutoff:t.cutoff, visible:t.selection.visibleIndices }) &&
      document.activeElement.id==='timeline-playhead' && document.getElementById('timeline-histogram').getBoundingClientRect().height===120 &&
      t.timeline.bins.every(bin=>t.geometry.xForTime(bin.end)-t.geometry.xForTime(bin.start)>=12-.001)`,
    `${width}px resize retains counts, aggregation, y-domain, membership, cutoff, focus and plot height`);
    for (const portion of [0, .5, 1]) {
      await evaluate(`document.getElementById('timeline-stage').scrollLeft=(t.geometry.contentWidth-document.getElementById('timeline-stage').clientWidth)*${portion}`);
      await sleep(30);
      await timelineAlignmentChecks({ evaluate, check }, `${width}px shared bars, ticks and playhead align after ${portion} scroll`);
    }
  }
  await key('Home');
  await check(`t.cutoff===t.timeline.bins[0].start&&!t.selection.visibleIndices.length`, 'Home selects the finite before-first boundary');
  await key('End'); await key('ArrowRight');
  await check(`t.cutoff===t.timeline.bins.at(-1).end&&document.getElementById('timeline-latest').getAttribute('aria-pressed')==='false'`,
    'last finite cutoff clamps on Right while Latest remains a separate action');
  await key('Escape');
  await check(`t.cutoff===null&&t.inspection===t.timeline.bins.length-1`, 'Escape restores Latest and the final-period summary');

  await key('ArrowLeft', 'timeline-histogram');
  await evaluate(`globalThis.inspectionCutoff=t.cutoff; globalThis.inspectionMap=JSON.stringify(t.snapshot()); globalThis.inspected=t.inspection`);
  await key('ArrowLeft', null);
  await check(`t.cutoff===inspectionCutoff&&t.inspection===inspected-1&&JSON.stringify(t.snapshot())===inspectionMap`,
    'chart arrows inspect adjacent periods without changing snapshot or map');
  await key('Enter', null);
  await check(`t.cutoff===t.timeline.bins[t.inspection].end&&document.activeElement.id==='timeline-histogram'`,
    'chart Enter selects the inspected bin end and retains focus');
  await key('Tab', 'timeline-histogram');
  await check(`t.inspection===t.timeline.bins.findIndex(bin=>t.cutoff>bin.start&&t.cutoff<=bin.end)`,
    'ending keyboard inspection restores the selected-period summary');

  // Hover an empty interval: its exact zero is inspectable despite no bar.
  const hover = await evaluate(`(() => {
    const index=t.timeline.bins.findIndex(bin=>!bin.count), stage=document.getElementById('timeline-stage');
    const bin=t.timeline.bins[index], x=t.geometry.xForTime((bin.start+bin.end)/2);
    stage.scrollLeft=x-stage.clientWidth/2;
    const r=stage.getBoundingClientRect(), canvas=document.getElementById('timeline-histogram').getBoundingClientRect();
    return {index,x:t.geometry.contentToClientX(x,r,stage.scrollLeft),y:canvas.top+60};
  })()`);
  await evaluate(`globalThis.hoverCutoff=t.cutoff; globalThis.hoverVisible=JSON.stringify(t.selection.visibleIndices)`);
  await sleep(100); // Finish native scroll events before pointing at the new content.
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y });
  await check(`t.inspection===${hover.index}&&document.getElementById('timeline-bin-summary').textContent.includes('0 albums')&&
    t.cutoff===hoverCutoff&&JSON.stringify(t.selection.visibleIndices)===hoverVisible&&
    !document.getElementById('timeline-period-tooltip').hidden`, 'hover exposes an empty period without changing map eligibility');
  await check(`(() => { const r=document.getElementById('timeline-period-tooltip').getBoundingClientRect();
    return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight; })()`, 'period tooltip stays readable within the viewport');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await check(`t.inspection===t.timeline.bins.findIndex(bin=>t.cutoff>bin.start&&t.cutoff<=bin.end)`,
    'ending hover restores the selected-period summary');

  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await evaluate(`(() => { const stage=document.getElementById('timeline-stage'); stage.scrollLeft=(stage.scrollWidth-stage.clientWidth)/2;
    document.getElementById('timeline-playhead').focus(); globalThis.panCutoff=t.cutoff; globalThis.panPose=t.snapshot(); globalThis.panScroll=stage.scrollLeft; })()`);
  const touch = async (type, points) => {
    await call('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x,y],index)=>({x,y,id:index+31})) });
    await sleep(30);
  };
  const chart = await evaluate(`(() => { const r=document.getElementById('timeline-stage').getBoundingClientRect(),
    c=document.getElementById('timeline-histogram').getBoundingClientRect(); return {x:r.left+r.width*.75,y:c.top+60,width:r.width}; })()`);
  await touch('touchStart', [[chart.x,chart.y]]);
  for (let step=1;step<=6;step++) await touch('touchMove', [[chart.x-step*20,chart.y]]);
  await touch('touchEnd', []); await sleep(200);
  await check(`Math.abs(document.getElementById('timeline-stage').scrollLeft-panScroll)>20&&t.cutoff===panCutoff&&
    JSON.stringify(t.snapshot().camera)===JSON.stringify(panPose.camera)&&t.graph.getZoomLevel()===panPose.zoom`,
    'horizontal chart swipes scroll history without selecting a snapshot or moving the graph');

  await evaluate(`(() => { const stage=document.getElementById('timeline-stage'); stage.scrollLeft=(stage.scrollWidth-stage.clientWidth)/2; })()`);
  const tap = await evaluate(`(() => { const r=document.getElementById('timeline-stage').getBoundingClientRect(),
    c=document.getElementById('timeline-histogram').getBoundingClientRect(), x=r.left+r.width/2;
    const index=t.geometry.binIndexForX(t.geometry.clientToContentX(x,r,document.getElementById('timeline-stage').scrollLeft));
    return {x,y:c.top+60,end:t.timeline.bins[index].end}; })()`);
  await touch('touchStart', [[tap.x,tap.y]]); await touch('touchEnd', []);
  await check(`t.cutoff===${tap.end}`, 'a stationary chart tap selects the bin end');
  await evaluate(`t.setCutoff(t.timeline.bins.at(-1).end); t.view.ensureTimeVisible(t.cutoff); document.getElementById('timeline-playhead').focus();
    globalThis.scrubPose=t.snapshot(); globalThis.scrubCutoff=t.cutoff;`);
  const scrub = await evaluate(`(() => { const stage=document.getElementById('timeline-stage'), r=stage.getBoundingClientRect(),
    input=document.getElementById('timeline-playhead').getBoundingClientRect(); return {x:t.geometry.contentToClientX(t.geometry.plot.right,r,stage.scrollLeft), y:input.top+16}; })()`);
  await touch('touchStart', [[scrub.x,scrub.y]]);
  for (let step=1;step<=6;step++) await touch('touchMove', [[scrub.x-step*15,scrub.y]]);
  await touch('touchEnd', []); await sleep(200);
  await check(`t.cutoff<scrubCutoff&&document.activeElement.id==='timeline-playhead'&&
    JSON.stringify(t.snapshot().camera)===JSON.stringify(scrubPose.camera)&&t.graph.getZoomLevel()===scrubPose.zoom`,
    'dedicated scrubber dragging changes snapshots while retaining focus and camera');
  await evaluate(`globalThis.cancelCutoff=t.cutoff;
    const control=document.getElementById('timeline-playhead');
    control.value=t.timeline.bins[0].end; control.dispatchEvent(new Event('input',{bubbles:true}));
    control.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:47}));`);
  await sleep(50);
  await check(`t.cutoff===cancelCutoff&&Number(document.getElementById('timeline-playhead').value)===cancelCutoff`,
    'pointer cancellation discards a queued scrub and restores the accessible control value');

  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: width===390?844:1000, deviceScaleFactor:1, mobile:width===390 });
    await evaluate(`t.setCutoff(null); t.view.ensureTimeVisible(t.timeline.bins.at(-1).end); document.getElementById('timeline-content').scrollTop=0;`);
    await sleep(200); await screenshot(`histogram-${width}`);
  }
  await evaluate(`globalThis.compositionFixture=structuredClone(histogramOriginal);
    compositionFixture.labels=[]; delete compositionFixture.bookmarks;
    compositionFixture.albums=Array.from({length:24},(_,index)=> {
      const album=structuredClone(histogramOriginal.albums[index%histogramOriginal.albums.length]);
      return {...album,id:index+1,first_played:index===23?'2024-03-01':'2024-02-29',
        vector:Array.from({length:24},(_,dimension)=>Number(dimension===index))};
    });
    compositionFixture.vector_dimension=24;
    document.getElementById('use-threshold').checked=true; document.getElementById('threshold').value=.7;
    t.load(compositionFixture,'Many-community spike fixture');`);
  await wait(`!document.getElementById('search').disabled&&t.aggregation?.majorCommunities.length===5&&t.timeline.maxCount===23`);
  await evaluate(`t.graph.pause(); t.setCutoff(t.timeline.bins[0].end);
    globalThis.compositionInvariant=JSON.stringify({major:t.aggregation.majorCommunities,stacks:t.segments,scale:t.aggregation.scale});
    document.getElementById('timeline-breakdown').open=true;`);
  await check(`t.aggregation.otherCount===19&&t.aggregation.breakdowns[0].length===23&&
    document.querySelectorAll('#timeline-community-table tr').length===23&&document.querySelectorAll('#timeline-bin-groups li').length===3&&
    document.getElementById('timeline-remaining').textContent.includes('20 remaining communities')&&
    document.getElementById('timeline-legend').textContent.includes('Other communities (combined)')&&
    document.getElementById('timeline-peak').textContent.includes('23 albums')&&
    t.segments.every((segments,index)=>segments.reduce((count,segment)=>count+segment.count,0)===t.timeline.bins[index].count)`,
    'many communities use five global series plus exact Other stacks, a local top three and the complete accessible table');
  await evaluate(`document.getElementById('search').value=t.data.albums[0].album; document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}));
    t.setCutoff(t.timeline.bins.at(-1).end);`);
  await check(`compositionInvariant===JSON.stringify({major:t.aggregation.majorCommunities,stacks:t.segments,scale:t.aggregation.scale})&&
    t.selection.visibleIndices.length<t.timeline.total`, 'search and scrubbing cannot rerank global communities or rescale a spike');
  await evaluate(`compositionFixture.albums.forEach(album=>album.first_played='2024-02-29');
    t.load(compositionFixture,'Single-bin leap-day fixture');`);
  await wait(`!document.getElementById('search').disabled&&t.timeline.bins.length===1&&t.timeline.maxCount===24`);
  await key('Home'); await key('ArrowRight'); await key('ArrowRight');
  await check(`t.cutoff===Date.parse('2024-03-01T00:00:00Z')&&t.selection.visibleIndices.length===24&&
    document.getElementById('timeline-latest').getAttribute('aria-pressed')==='false'`, 'single-bin leap-day history has a finite final cutoff and clamped keyboard movement');
  await evaluate(`globalThis.emptyFixture=structuredClone(histogramOriginal); emptyFixture.albums=[];emptyFixture.labels=[];
    delete emptyFixture.bookmarks;delete emptyFixture.cover_atlases;delete emptyFixture.library;
    t.load(emptyFixture,'Empty timeline fixture');`);
  await wait(`document.getElementById('status').textContent.includes('Empty export loaded')`);
  await check(`t.cutoff===null&&!t.timeline.bins.length&&!document.getElementById('timeline-empty').hidden&&
    document.getElementById('timeline-controls').hidden&&!document.querySelector('.ag-bookmark-list')`,
    'empty exports clear temporal state and overlays without inventing an interval');
  await evaluate(`t.load(histogramOriginal,'Original timeline fixture')`);
  await wait(`!document.getElementById('search').disabled&&!document.getElementById('timeline-playhead').disabled`);
  assert.equal(await evaluate('t.cutoff'), null);
}

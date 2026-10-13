import assert from 'node:assert/strict';

// ECharts owns the plot scale; the event rail must follow its visible window.
// The snapshot scrubber deliberately retains its separate full-history scale.
export async function timelineAlignmentChecks({ evaluate, check }, label) {
  await check(`(() => {
    const geometry=t.geometry, chart=t.view.chart.chart, rect=document.getElementById('timeline-histogram').getBoundingClientRect();
    const pixel=time=>chart.convertToPixel({xAxisIndex:0},time);
    const client=time=>rect.left+pixel(Math.max(t.view.range.startMs,Math.min(t.view.range.endMs,time)));
    const close=(a,b)=>Math.abs(a-b)<=1;
    for (const time of [t.view.range.startMs,(t.view.range.startMs+t.view.range.endMs)/2,t.view.range.endMs]) {
      if (!close(pixel(time),geometry.xForTime(time)) || Math.abs(chart.convertFromPixel({xAxisIndex:0},pixel(time))-time)>1) return false;
    }
    const range=document.getElementById('timeline-playhead'), r=range.getBoundingClientRect(), value=Number(range.value), snapshot=t.view.snapshotGeometry;
    const center=snapshot.thumbInset+(value-Number(range.min))/(Number(range.max)-Number(range.min))*(r.width-2*snapshot.thumbInset);
    if (!close(center,snapshot.xForTime(value)) || Number(range.min)!==t.timeline.bins[0].start || Number(range.max)!==t.timeline.bins.at(-1).end) return false;
    if (![...document.querySelectorAll('#timeline-bookmarks .ag-bookmark-anchor[data-bookmark-id]')].every(marker=> {
      const bookmark=t.timeline.bookmarks.find(bookmark=>bookmark.id===marker.dataset.bookmarkId), r=marker.getBoundingClientRect();
      return bookmark&&close(r.left+r.width/2,client(bookmark.start));
    })) return false;
    if (![...document.querySelectorAll('#timeline-bookmarks .ag-bookmark-span')].every(span=> {
      const start=span.getPointAtLength(0).matrixTransform(span.getScreenCTM());
      const end=span.getPointAtLength(span.getTotalLength()).matrixTransform(span.getScreenCTM());
      return t.timeline.bookmarks.some(bookmark=>bookmark.end!==null&&close(start.x,client(bookmark.start))&&close(end.x,client(bookmark.end+86400000)));
    })) return false;
    return chart.getOption().xAxis[0].type==='time' && chart.getOption().dataZoom.length===2 &&
      t.view.chart.prepared.rows.every(row=>row.start===t.displayModel.bins[row.index].start&&row.end===t.displayModel.bins[row.index].end)&&
      document.querySelector('#timeline-histogram canvas')&&document.getElementById('timeline-stage').scrollWidth<=document.getElementById('timeline-stage').clientWidth+1;
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
      await evaluate(`(() => { const full=t.view.domain, span=(full.endMs-full.startMs)/2;
        t.view.setRange({startMs:full.startMs+span*${part},endMs:full.startMs+span*(${part}+1)}); })()`);
      await sleep(100);
      await timelineAlignmentChecks({ evaluate, check }, `${width}px event anchors and range endpoints follow ECharts in window ${part}`);
    }
    await evaluate(`t.view.setRange(t.view.domain); t.setCutoff(t.timeline.bins[0].start);
      globalThis.clusterPin=document.querySelector('.ag-bookmark-target[aria-haspopup=dialog]');
      clusterPin.scrollIntoView({block:'nearest',inline:'nearest'}); clusterPin.focus();
      globalThis.clusterCutoff=t.cutoff; globalThis.clusterPose=t.snapshot();`);
    await key('Enter', null);
    await check(`!document.querySelector('.ag-bookmark-list').hidden&&document.activeElement.classList.contains('ag-bookmark-entry')&&t.cutoff===clusterCutoff`,
      `${width}px opening an event list previews dates without changing the snapshot`);
    await check(`(() => { const entry=document.activeElement, id=entry.dataset.bookmarkId,
      bookmark=t.timeline.bookmarks.find(bookmark=>bookmark.id===id), tooltip=document.querySelector('.ag-bookmark-tooltip'), r=entry.getBoundingClientRect();
      return t.view.guideTime===bookmark.start&&tooltip.hidden&&entry.textContent.includes(bookmark.date)&&
        r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&
        JSON.stringify(t.snapshot().camera)===JSON.stringify(clusterPose.camera);
    })()`, `${width}px an individual event previews its exact date guide with the date readable in the list`);
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
  await evaluate(`globalThis.explorerControl=(id,value)=>{const control=document.getElementById(id);control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));};
    globalThis.histogramOriginal=structuredClone(t.data); globalThis.longHistory=structuredClone(t.data);
    longHistory.albums.forEach((album,index)=> {
      delete album.added;
      const month=Math.round(index/(longHistory.albums.length-1)*119);
      album.first_played=new Date(Date.UTC(2014,month,1)).toISOString().slice(0,10);
      album.first_played_source=index%2?'lastfm':'added'; album.genre=index%2?'Jazz':'Rock'; album.albumartist='Artist '+index%3;
    });
    delete longHistory.bookmarks;
    for(const [id,value] of [['timeline-group','cluster'],['timeline-interval','auto'],['timeline-mode','count']]) document.getElementById(id).value=value;
    t.load(longHistory,'Ten-year timeline fixture');`);
  await wait(`!document.getElementById('search').disabled&&!document.getElementById('timeline-playhead').disabled&&t.displayModel?.bins.length===120`);
  await evaluate(`if(document.getElementById('timeline-content').hidden) document.getElementById('timeline-toggle').click();
    t.graph.pause(); t.setCutoff(t.timeline.bins[60].end); document.getElementById('timeline-playhead').focus();
    globalThis.historyInvariant=JSON.stringify({bins:t.displayModel.bins,scale:t.aggregation.scale,stacks:t.segments,cutoff:t.cutoff,visible:t.selection.visibleIndices});`);
  for (const width of [1440, 390, 1440]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: width===390?844:1000, deviceScaleFactor:1, mobile:width===390 });
    await sleep(200);
    await check(`historyInvariant===JSON.stringify({bins:t.displayModel.bins,scale:t.aggregation.scale,stacks:t.segments,cutoff:t.cutoff,visible:t.selection.visibleIndices})&&
      document.activeElement.id==='timeline-playhead'&&document.getElementById('timeline-histogram').getBoundingClientRect().height===220&&
      document.documentElement.scrollWidth<=innerWidth`, `${width}px resize preserves aggregation, snapshot, focus and chart height without horizontal overflow`);
    await timelineAlignmentChecks({ evaluate, check }, `${width}px ECharts time axis and rail agree while the scrubber retains full history`);
  }
  await key('Home');
  await check(`t.cutoff===t.timeline.bins[0].start&&!t.selection.visibleIndices.length`, 'Home selects the finite before-first boundary');
  await key('End'); await key('ArrowRight');
  await check(`t.cutoff===t.timeline.bins.at(-1).end&&document.getElementById('timeline-latest').getAttribute('aria-pressed')==='false'`,
    'last finite snapshot clamps on Right while Latest remains separate');
  await key('Escape');
  await check(`t.cutoff===null&&t.inspection===t.displayModel.bins.length-1`, 'Escape restores Latest and the final visible-period summary');
  await key('ArrowLeft', 'timeline-histogram');
  await evaluate(`globalThis.inspectionMap=JSON.stringify(t.snapshot());globalThis.inspected=t.inspection;`);
  await key('ArrowLeft', null);
  await check(`t.cutoff===null&&t.inspection===inspected-1&&JSON.stringify(t.snapshot())===inspectionMap`,
    'chart arrows inspect adjacent periods without changing snapshot or map');
  await key('Enter', null);
  await check(`t.cutoff===t.displayModel.bins[t.inspection].end&&document.activeElement.id==='timeline-histogram'`,
    'chart Enter selects the inspected period snapshot and retains focus');
  await key('Tab', 'timeline-histogram');
  await check(`t.inspection===t.displayModel.bins.findIndex(bin=>t.cutoff>bin.start&&t.cutoff<=bin.end)`,
    'ending keyboard inspection restores the selected-period summary');

  await evaluate(`t.setCutoff(null);t.graph.pause();globalThis.explorePose=JSON.stringify(t.snapshot());
    globalThis.fullRange={...t.view.domain};
    t.view.setRange({startMs:Date.parse('2020-01-01T00:00:00Z'),endMs:Date.parse('2021-01-01T00:00:00Z')});`);
  await check(`t.displayModel.unit==='week'&&t.displayModel.bins.every(bin=>new Date(bin.start).getUTCDay()===1)&&
    JSON.stringify(t.snapshot())===explorePose&&t.cutoff===null&&
    Number(document.getElementById('timeline-playhead').min)===fullRange.startMs&&Number(document.getElementById('timeline-playhead').max)===fullRange.endMs`,
    'one-year zoom rebins to Monday weeks without changing map membership, camera or snapshot domain');
  await evaluate(`explorerControl('timeline-from','2020-02-01');explorerControl('timeline-through','2020-03-01');`);
  await check(`t.displayModel.unit==='day'&&t.displayModel.bins.some(bin=>bin.start===Date.parse('2020-02-29T00:00:00Z'))&&
    t.view.range.endMs===Date.parse('2020-03-02T00:00:00Z')&&JSON.stringify(t.snapshot())===explorePose`,
    'date inputs use an inclusive Through day and expose leap-day bins when zoomed');
  for (const unit of ['week','month','year','auto']) {
    await evaluate(`explorerControl('timeline-interval',${JSON.stringify(unit)})`);
    await check(`t.displayModel.unit===${JSON.stringify(unit==='auto'?'day':unit)}&&JSON.stringify(t.snapshot())===explorePose`,
      `${unit} interval selection recomputes the chart without filtering the graph`);
  }
  for (const [group, count] of [['genre',2],['albumartist',3],['source',2]]) {
    await evaluate(`t.view.setRange(t.view.domain);explorerControl('timeline-group',${JSON.stringify(group)});`);
    await check(`t.aggregation.communities.length===${count}&&t.segments.every((segments,index)=>
      segments.reduce((sum,segment)=>sum+segment.count,0)===t.displayModel.bins[index].count)&&JSON.stringify(t.snapshot())===explorePose`,
      `${group} groups use the exported album metadata and preserve total counts`);
  }
  await evaluate(`explorerControl('timeline-mode','percent');`);
  await check(`t.view.chart.chart.getOption().yAxis[0].max===100&&t.view.chart.prepared.rows.every(row=>
    row.total===0?!row.segments.length:Math.abs(row.segments.at(-1).top-100)<1e-8)&&
    document.getElementById('timeline-measure').textContent.includes('share')&&JSON.stringify(t.snapshot())===explorePose`,
    'share mode normalizes nonempty periods to 100% while keeping the graph unchanged');
  await evaluate(`globalThis.hiddenName=t.aggregation.majorCommunities[0].name;
    document.querySelector('#timeline-legend button').click();`);
  await check(`t.view.hiddenGroups.has(hiddenName)&&document.querySelector('#timeline-legend button').getAttribute('aria-pressed')==='false'&&
    !document.getElementById('timeline-show-groups').hidden&&t.view.chart.prepared.rows.every(row=>row.segments.every(segment=>segment.name!==hiddenName))&&
    JSON.stringify(t.snapshot())===explorePose`, 'legend buttons hide a chart group without changing map membership');
  await evaluate(`document.getElementById('timeline-show-groups').click();explorerControl('timeline-mode','count');`);
  await check(`!t.view.hiddenGroups.size&&document.getElementById('timeline-show-groups').hidden&&
    [...document.querySelectorAll('#timeline-legend button')].every(button=>button.getAttribute('aria-pressed')==='true')`,
    'Show all groups restores every chart series and pressed state');

  // Exercise ECharts' real dataZoom event path, not only the view's setter.
  await evaluate(`t.view.chart.chart.dispatchAction({type:'dataZoom',start:25,end:75});`);
  await wait(`Math.abs(t.view.range.startMs-(fullRange.startMs+(fullRange.endMs-fullRange.startMs)*.25))<2`);
  await check(`Math.abs(t.view.range.endMs-(fullRange.startMs+(fullRange.endMs-fullRange.startMs)*.75))<2&&
    JSON.stringify(t.snapshot())===explorePose&&t.cutoff===null`, 'ECharts navigator changes only the visible date window');
  await timelineAlignmentChecks({ evaluate, check }, 'navigator zoom keeps ECharts, calendar boundaries and event geometry aligned');
  await evaluate(`globalThis.zoomSpan=t.view.range.endMs-t.view.range.startMs;document.getElementById('timeline-zoom-in').click();`);
  await check(`Math.abs(t.view.range.endMs-t.view.range.startMs-zoomSpan/2)<2`, 'keyboard-accessible zoom-in halves the window');
  await evaluate(`document.getElementById('timeline-zoom-out').click();`);
  await check(`Math.abs(t.view.range.endMs-t.view.range.startMs-zoomSpan)<2`, 'zoom-out restores the previous span');
  await evaluate(`document.getElementById('timeline-reset-zoom').click();`);
  await check(`JSON.stringify(t.view.range)===JSON.stringify(fullRange)&&JSON.stringify(t.snapshot())===explorePose`,
    'All dates restores the chart domain without changing the map');

  // Empty daily bins remain inspectable even though there is no colored bar.
  await evaluate(`t.view.setRange({startMs:Date.parse('2020-02-01T00:00:00Z'),endMs:Date.parse('2020-03-02T00:00:00Z')});
    document.getElementById('timeline-histogram').scrollIntoView({block:'center'});`);
  const hover = await evaluate(`(() => {const index=t.displayModel.bins.findIndex(bin=>!bin.count),bin=t.displayModel.bins[index],
    r=document.getElementById('timeline-histogram').getBoundingClientRect();
    return {index,x:r.left+t.view.chart.chart.convertToPixel({xAxisIndex:0},(bin.start+bin.end)/2),y:r.top+70};})()`);
  await call('Input.dispatchMouseEvent', { type:'mouseMoved', x:hover.x, y:hover.y });
  await check(`t.inspection===${hover.index}&&document.getElementById('timeline-bin-summary').textContent.includes('0 albums')&&
    JSON.stringify(t.snapshot())===explorePose`, 'hovering an empty period reports zero albums without changing the graph');
  await call('Input.dispatchMouseEvent', { type:'mouseMoved', x:5, y:5 });
  await evaluate(`globalThis.wheelSpan=t.view.range.endMs-t.view.range.startMs;`);
  await call('Input.dispatchMouseEvent', { type:'mouseWheel', x:hover.x, y:hover.y, deltaX:0, deltaY:-160 });
  await wait(`t.view.range.endMs-t.view.range.startMs<wheelSpan`);
  await check(`t.cutoff===null&&JSON.stringify(t.snapshot())===explorePose`, 'wheel zoom is contained within the timeline and leaves map pose and membership unchanged');

  await evaluate(`t.view.setRange({startMs:Date.parse('2020-01-01T00:00:00Z'),endMs:Date.parse('2021-01-01T00:00:00Z')});
    globalThis.filterRange={...t.view.range};document.getElementById('timeline-filter-range').click();`);
  await check(`t.view.rangeFilter.startMs===filterRange.startMs&&t.view.rangeFilter.endMs===filterRange.endMs&&
    !document.getElementById('timeline-clear-range').hidden&&t.cutoff===null&&
    JSON.stringify(t.selection.visibleIndices)===JSON.stringify(Array.from(t.timeline.dates).flatMap((date,index)=>date>=filterRange.startMs&&date<filterRange.endMs?[index]:[]))`,
    'Show range on map explicitly filters to the selected half-open interval');
  await evaluate(`globalThis.rangeMembers=JSON.stringify(t.selection.visibleIndices);document.getElementById('timeline-reset-zoom').click();`);
  await check(`JSON.stringify(t.selection.visibleIndices)===rangeMembers&&t.view.rangeFilter.startMs===filterRange.startMs`,
    'changing chart zoom after applying a range preserves the chosen map filter');
  await evaluate(`t.setCutoff(Date.parse('2020-07-01T00:00:00Z'));`);
  await check(`JSON.stringify(t.selection.visibleIndices)===JSON.stringify(Array.from(t.timeline.dates).flatMap((date,index)=>
    date>=filterRange.startMs&&date<Math.min(filterRange.endMs,t.cutoff)?[index]:[]))`,
    'range filtering intersects cumulative snapshots instead of replacing them');
  await evaluate(`document.getElementById('timeline-clear-range').click();`);
  await check(`!t.view.rangeFilter&&document.getElementById('timeline-clear-range').hidden&&t.cutoff===Date.parse('2020-07-01T00:00:00Z')&&
    t.selection.visibleIndices.length===Array.from(t.timeline.dates).filter(date=>Number.isFinite(date)&&date<t.cutoff).length`,
    'clearing a range filter restores cumulative membership and keeps the snapshot');

  await call('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
  await call('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:5 });
  await evaluate(`t.setCutoff(null);t.graph.pause();t.view.setRange({startMs:Date.parse('2018-01-01T00:00:00Z'),endMs:Date.parse('2020-01-01T00:00:00Z')});
    document.getElementById('timeline-histogram').scrollIntoView({block:'center'});globalThis.panRange={...t.view.range};globalThis.panPose=JSON.stringify(t.snapshot());`);
  await sleep(150);
  const touch = async (type, points) => {
    await call('Input.dispatchTouchEvent', { type, touchPoints:points.map(([x,y],index)=>({x,y,id:index+31})) });
    await sleep(30);
  };
  const chart = await evaluate(`(() => {const r=document.getElementById('timeline-histogram').getBoundingClientRect();return {x:r.left+r.width*.75,y:r.top+70};})()`);
  await touch('touchStart', [[chart.x,chart.y]]);
  for (let step=1;step<=6;step++) await touch('touchMove', [[chart.x-step*15,chart.y]]);
  await touch('touchEnd', []); await sleep(200);
  await check(`Math.abs(t.view.range.startMs-panRange.startMs)>86400000&&t.cutoff===null&&JSON.stringify(t.snapshot())===panPose`,
    'touch panning changes the date window without selecting a snapshot or moving the map');
  const tap = await evaluate(`(() => {const r=document.getElementById('timeline-histogram').getBoundingClientRect(),
    time=(t.view.range.startMs+t.view.range.endMs)/2,bin=t.displayModel.bins.find(bin=>time>=bin.start&&time<bin.end);
    return {x:r.left+t.view.chart.chart.convertToPixel({xAxisIndex:0},time),y:r.top+70,end:bin.end};})()`);
  await touch('touchStart', [[tap.x,tap.y]]); await touch('touchEnd', []);
  await check(`t.cutoff===${tap.end}`, 'a stationary chart tap still selects the visible period snapshot');
  await evaluate(`t.setCutoff(t.timeline.bins.at(-1).end);document.getElementById('timeline-playhead').scrollIntoView({block:'center'});
    document.getElementById('timeline-playhead').focus();globalThis.scrubPose=t.snapshot();globalThis.scrubCutoff=t.cutoff;`);
  const scrub = await evaluate(`(() => {const r=document.getElementById('timeline-playhead').getBoundingClientRect();return {x:r.right-8,y:r.top+r.height/2};})()`);
  await touch('touchStart', [[scrub.x,scrub.y]]);
  for (let step=1;step<=6;step++) await touch('touchMove', [[scrub.x-step*15,scrub.y]]);
  await touch('touchEnd', []); await sleep(200);
  await check(`t.cutoff<scrubCutoff&&document.activeElement.id==='timeline-playhead'&&JSON.stringify(t.snapshot().camera)===JSON.stringify(scrubPose.camera)&&t.graph.getZoomLevel()===scrubPose.zoom`,
    'separate full-history scrubber changes snapshots while retaining focus and camera');
  await evaluate(`globalThis.cancelCutoff=t.cutoff;const control=document.getElementById('timeline-playhead');
    control.value=t.timeline.bins[0].end;control.dispatchEvent(new Event('input',{bubbles:true}));
    control.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:47}));`);
  await sleep(50);
  await check(`t.cutoff===cancelCutoff&&Number(document.getElementById('timeline-playhead').value)===cancelCutoff`,
    'pointer cancellation discards a queued scrub and restores its accessible value');
  await call('Emulation.setTouchEmulationEnabled', { enabled:false });
  for (const width of [1440,390]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height:width===390?844:1000, deviceScaleFactor:1, mobile:width===390 });
    await evaluate(`t.setCutoff(null);t.view.setRange(t.view.domain);document.getElementById('timeline-content').scrollTop=0;`);
    await sleep(200); await screenshot(`histogram-${width}`);
  }

  await evaluate(`globalThis.compositionFixture=structuredClone(histogramOriginal);compositionFixture.labels=[];delete compositionFixture.bookmarks;
    compositionFixture.albums=Array.from({length:24},(_,index)=> {
      const album=structuredClone(histogramOriginal.albums[index%histogramOriginal.albums.length]);
      return {...album,id:index+1,first_played:index===23?'2024-03-01':'2024-02-29',vector:Array.from({length:24},(_,dimension)=>Number(dimension===index))};
    });
    compositionFixture.vector_dimension=24;document.getElementById('use-threshold').checked=true;document.getElementById('threshold').value=.7;
    for(const [id,value] of [['timeline-group','cluster'],['timeline-interval','auto'],['timeline-mode','count']]) document.getElementById(id).value=value;
    t.load(compositionFixture,'Many-community spike fixture');`);
  await wait(`!document.getElementById('search').disabled&&t.aggregation?.majorCommunities.length===5&&t.displayModel.maxCount===23`);
  await evaluate(`t.graph.pause();t.setCutoff(t.displayModel.bins[0].end);document.getElementById('timeline-breakdown').open=true;
    globalThis.compositionInvariant=JSON.stringify({communities:t.aggregation.communities,stacks:t.segments,scale:t.aggregation.scale});`);
  await check(`t.aggregation.communities.length===24&&t.segments[0].length===23&&document.querySelectorAll('#timeline-community-table tr').length===23&&
    document.querySelectorAll('#timeline-bin-groups li').length===3&&document.getElementById('timeline-remaining').textContent.includes('20 remaining groups')&&
    document.getElementById('timeline-legend-heading').textContent.includes('Map colors')&&document.getElementById('timeline-peak').textContent.includes('23 albums')&&
    t.segments.every((segments,index)=>segments.reduce((sum,segment)=>sum+segment.count,0)===t.displayModel.bins[index].count&&segments.every(segment=>t.view.colors.has(segment.name)))`,
    'all communities retain distinct identities, exact counts, a compact legend and a complete interactive table');
  await evaluate(`document.querySelector('#timeline-community-table button').click();`);
  await check(`t.view.hiddenGroups.size===1&&document.querySelector('#timeline-community-table button').getAttribute('aria-pressed')==='false'&&
    document.getElementById('timeline-bin-summary').textContent.includes('including hidden groups')`,
    'full period breakdown can toggle a group and exposes hidden counts');
  await evaluate(`document.getElementById('timeline-show-groups').click();document.getElementById('search').value=t.data.albums[0].album;
    document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}));t.setCutoff(t.timeline.bins.at(-1).end);`);
  await check(`compositionInvariant===JSON.stringify({communities:t.aggregation.communities,stacks:t.segments,scale:t.aggregation.scale})&&t.selection.visibleIndices.length<t.timeline.total`,
    'search and snapshot changes leave chart aggregation independent of map filters');
  await evaluate(`compositionFixture.albums.forEach(album=>album.first_played='2024-02-29');t.load(compositionFixture,'Single-bin leap-day fixture');`);
  await wait(`!document.getElementById('search').disabled&&t.timeline.bins.length===1&&t.displayModel.maxCount===24`);
  await key('Home'); await key('ArrowRight'); await key('ArrowRight');
  await check(`t.cutoff===Date.parse('2024-03-01T00:00:00Z')&&t.selection.visibleIndices.length===24&&document.getElementById('timeline-latest').getAttribute('aria-pressed')==='false'`,
    'single-bin leap-day history has a finite final cutoff and clamped keyboard movement');
  await evaluate(`globalThis.emptyFixture=structuredClone(histogramOriginal);emptyFixture.albums=[];emptyFixture.labels=[];
    delete emptyFixture.bookmarks;delete emptyFixture.cover_atlases;delete emptyFixture.library;t.load(emptyFixture,'Empty timeline fixture');`);
  await wait(`document.getElementById('status').textContent.includes('Empty export loaded')`);
  await check(`t.cutoff===null&&!t.timeline.bins.length&&!document.getElementById('timeline-empty').hidden&&document.getElementById('timeline-controls').hidden&&!document.querySelector('.ag-bookmark-list')`,
    'empty exports clear temporal state and overlays without inventing an interval');
  await evaluate(`t.load(histogramOriginal,'Original timeline fixture')`);
  await wait(`!document.getElementById('search').disabled&&!document.getElementById('timeline-playhead').disabled`);
  assert.equal(await evaluate('t.cutoff'), null);
}

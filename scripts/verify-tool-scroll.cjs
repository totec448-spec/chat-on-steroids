/** Real Chromium geometry gate: node scripts/verify-tool-scroll.cjs.
 * Uses synthetic content and current CSS, never the installed app or a user session. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true } });
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  const scrollCode = require('esbuild').transformSync(fs.readFileSync(path.join(__dirname, '../src/renderer/timeline-scroll.ts'), 'utf8'), { loader: 'ts', format: 'iife', globalName: 'timelineScroll' }).code;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style><script>${scrollCode}</script><div id="chatBody" style="height:700px;overflow:auto"><div id="timeline"></div></div>`));
  const observations = await win.webContents.executeJavaScript(`(async () => {
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = '<div class="ev"><p class="msg">Before</p></div><details class="tool-group" open><summary>Group</summary><div class="tool-group-body">' + Array.from({length:8}, (_,i) => '<div class="ev ev-tool_call"><div class="ev-body"><details class="tool"><summary>Read ' + i + '</summary><div class="raw"><h4>Result</h4><p class="pre">' + ('LINE ' + i + '\\n').repeat(200) + '</p></div></details></div></div>').join('') + '</div></details><div class="ev"><p class="msg">After</p></div>';
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const results = [];
    const tool = timeline.querySelectorAll('.tool')[1], pre = tool.querySelector('.pre');
    for (let i=0;i<12;i++) {
      tool.open = i%2===0;
      pre.scrollTop = i*30;
      document.getElementById('chatBody').scrollTop = i*10;
      await frame();
      const rows = [...timeline.querySelectorAll('.tool-group-body>.ev')].map(n => n.getBoundingClientRect());
      results.push({open:tool.open, overlap:rows.some((r,j) => j && r.top < rows[j-1].bottom-.1), resultHeight:pre.getBoundingClientRect().height});
    }
    tool.open = true; timeline.querySelector('.tool-group').open = false; await frame();
    results.push({closedGroupHeight:pre.getBoundingClientRect().height});
    return results;
  })()`);
  for (const result of observations.slice(0, -1)) {
    assert.equal(result.overlap, false, 'Activity rows must not overlap');
    if (result.open) assert.ok(result.resultHeight > 260, 'Open tool results expand into the chat instead of a nested vertical scroller');
    else assert.equal(result.resultHeight, 0, 'Collapsed tools have no result geometry');
  }
  assert.equal(observations.at(-1).closedGroupHeight, 0, 'Collapsed group removes descendant scroll geometry');
  const anchor = await win.webContents.executeJavaScript(`(async () => {
    const pane = document.getElementById('chatBody'), timeline = document.getElementById('timeline');
    timeline.innerHTML = Array.from({length:20}, (_,i) => '<div data-timeline-key="row-'+i+'" style="height:100px">Message '+i+'</div>').join('');
    pane.scrollTop = 700;
    const reading = timeline.children[7], offset = () => reading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    const before = offset(), restore = timelineScroll.preserveTimelineViewport(pane, timeline);
    timeline.children[1].style.height = '280px';
    const unanchored = offset();
    restore();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = offset();
    pane.scrollTop = pane.scrollHeight;
    const follow = timelineScroll.preserveTimelineViewport(pane, timeline);
    timeline.append(timeline.children[0].cloneNode(true)); follow();
    return {before, unanchored, after, bottomGap:pane.scrollHeight-pane.clientHeight-pane.scrollTop};
  })()`);
  assert.equal(anchor.after, anchor.before, 'Late text above the viewport must preserve the reader row position');
  assert.equal(anchor.unanchored - anchor.before, 180, 'Absolute scrollTop reproduces the reader jump before restoration');
  assert.equal(anchor.bottomGap, 0, 'Readers already at the bottom continue following new rows');
  const paging = await win.webContents.executeJavaScript(`(() => {
    const pane = document.getElementById('chatBody'), timeline = document.getElementById('timeline');
    timeline.innerHTML = Array.from({length:160}, (_,i) => '<div data-timeline-key="page-'+i+'" style="height:40px">Message '+i+'</div>').join('');
    pane.scrollTop = pane.scrollHeight;
    const row = timeline.children[145], offset = () => row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    const before = offset(), restore = timelineScroll.preserveTimelineViewport(pane, timeline, false);
    for (let i=0;i<80;i++) timeline.firstElementChild.remove();
    timeline.insertAdjacentHTML('beforeend', Array.from({length:80}, (_,i) => '<div data-timeline-key="next-'+i+'" style="height:40px">Newer '+i+'</div>').join(''));
    restore();
    return {before, after:offset(), bottomGap:pane.scrollHeight-pane.clientHeight-pane.scrollTop};
  })()`);
  assert.equal(paging.after, paging.before, 'Forward paging must retain the reader position after older rows are evicted');
  assert.ok(paging.bottomGap > 3000, 'Forward paging must expose newer rows below the reader instead of jumping past them');
  // Native wheel routing, including a failed tool and both long compaction sections.
  win.webContents.debugger.attach('1.3');
  for (const kind of ['failed-tool', 'brief-request', 'streaming-summary']) {
    const point = await win.webContents.executeJavaScript(`(() => {
      const pane = document.getElementById('chatBody'), timeline = document.getElementById('timeline');
      const kind = ${JSON.stringify(kind)};
      const text = ('A line of recorded output or handoff text.\\n').repeat(180);
      timeline.innerHTML = '<div style="height:200px">Earlier messages</div><div class="ev" data-timeline-key="reading"><div class="ev-body"><details class="tool ' + (kind === 'failed-tool' ? 'tone-bad' : 'compaction') + '" open><summary>' + kind + '</summary><div class="raw"><h4>Content</h4><div class="' + (kind === 'streaming-summary' ? 'msg rich' : 'pre') + '"></div></div></details></div></div><div style="height:800px">Later messages</div>';
      const content = timeline.querySelector('.raw > div');
      if (kind === 'streaming-summary') {
        for (let i=0;i<100;i++) { const p=document.createElement('p'); p.textContent='Summary paragraph '+i; content.append(p); }
      } else content.textContent = text;
      pane.scrollTop = content.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop + 100;
      const bounds = pane.getBoundingClientRect();
      return {x:Math.round(content.getBoundingClientRect().left+50), y:Math.round(bounds.top+150), before:pane.scrollTop, nested:content.scrollHeight-content.clientHeight};
    })()`);
    assert.equal(point.nested, 0, `${kind} must not have nested vertical overflow`);
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaY: 180, deltaX: 0 });
    await new Promise(resolve => setTimeout(resolve, 200));
    const movement = await win.webContents.executeJavaScript(`(() => {
      const pane=document.getElementById('chatBody'), timeline=document.getElementById('timeline');
      const content=timeline.querySelector('.raw > div');
      const afterWheel=pane.scrollTop;
      for(let i=0;i<8;i++) {
        const restore=timelineScroll.preserveTimelineViewport(pane,timeline);
        if(content.classList.contains('rich')) { const p=document.createElement('p'); p.textContent='New summary paragraph'; content.append(p); }
        restore();
      }
      return {afterWheel, afterUpdates:pane.scrollTop, inner:content.scrollTop};
    })()`);
    assert.ok(movement.afterWheel > point.before, `${kind}: wheel over content must scroll the chat (${JSON.stringify({point, movement})})`);
    assert.equal(movement.inner, 0, `${kind}: inner text must not scroll independently`);
    assert.equal(movement.afterUpdates, movement.afterWheel, `${kind}: updates must preserve the reader position`);
  }
  console.log(`Tool scroll geometry passed: Electron ${process.versions.electron}, 12 disclosure/scroll cycles, collapse, viewport anchoring, bottom following, paging and native wheel routing over failed tools and compaction during updates.`);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

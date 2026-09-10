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
    assert.equal(result.resultHeight, result.open ? 260 : 0, 'Only open tool results have scroll geometry');
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
  console.log(`Tool scroll geometry passed: Electron ${process.versions.electron}, 12 disclosure/scroll cycles, outer-group collapse, late-content anchor and bottom following.`);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

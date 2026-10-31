import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {parseResults} from '../core.mjs';
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.join(root,'test-results');
const fixture=JSON.parse(fs.readFileSync(path.join(root,'samples/demo-graph.json'),'utf8'));fixture.graph.status='draft';
fixture.graph.emotion_states.find(s=>s.id==='state_1').end_time=5;
fixture.graph.emotion_states.find(s=>s.id==='state_2').end_time=10;
fixture.graph.links.push({id:'event-state-order',from_type:'event',from_id:'event_1',to_type:'emotion_state',to_id:'state_2',type:'associated_with'});
let executablePath=process.env.BROWSER_EXECUTABLE;
if(!executablePath&&process.platform==='win32'){const cache=path.join(os.homedir(),'AppData/Local/ms-playwright');for(const dir of fs.readdirSync(cache).sort().reverse()){const candidate=path.join(cache,dir,'chrome-win64/chrome.exe');if(dir.startsWith('chromium-')&&fs.existsSync(candidate)){executablePath=candidate;break;}}}
const browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.type()==='beforeunload'?d.accept():d.dismiss());
const state=()=>page.evaluate(async()=>(await(await import('./storage.mjs')).listWorkspaces())[0]);
async function wait(predicate){const end=Date.now()+12000;while(Date.now()<end){const ws=await state();if(ws&&predicate(ws))return ws;await page.waitForTimeout(80);}throw new Error('Time-order autosave timed out');}
const stage=name=>page.locator('.g-tab[data-stage='+name+']').click();
const fact=ws=>ws.graph.facts.find(f=>f.id==='fact_1');
async function factForm(){await stage('facts');await page.locator('.g-node[data-node-id=fact_1]').click();if(!await page.locator('#g-fact-time-mode').isVisible())await page.locator('.g-fact-temporal>summary').click();}
async function warning(){await page.waitForFunction(()=>document.querySelector('.g-feedback.error')?.textContent.includes('结束'));await page.waitForTimeout(800);}
async function drag(type,id,delta){const bar=page.locator('.g-layer-view .g-time-row[data-node-type='+type+'][data-node-id='+id+'] .g-time-band').first();await bar.scrollIntoViewIfNeeded();const box=await bar.boundingBox(),lane=await page.locator('.g-layer-view .g-time-packed-lane').first().boundingBox();const x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+lane.width*delta/12.032,y,{steps:8});await page.mouse.up();}
try{
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:8793/');
  await page.locator('#result-input').setInputFiles({name:'time-order.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.waitForSelector('#workspace:not([hidden])');
  const media=path.join(root,'.tools/browser-fixtures/demo-task');await page.locator('#folder-input').setInputFiles(media);await page.waitForFunction(()=>document.getElementById('video').readyState>=2);
  const original=await state(),records=structuredClone(original.records);
  await factForm();await page.locator('#g-fact-time-mode').selectOption('independent');await page.locator('#g-fact-time-start-0').fill('.5');await page.locator('#g-fact-time-end-0').fill('4.5');await wait(ws=>fact(ws).time_ranges?.[0].end_time===4.5);
  assert.deepEqual((await state()).records,records);console.log('PASS: earlier start and overlap save while atomic evidence remains unchanged');
  await page.locator('#g-fact-time-end-0').fill('2.5');await warning();assert.equal(fact(await state()).time_ranges[0].end_time,4.5);assert.equal(await page.locator('#g-fact-time-end-0').inputValue(),'2.5');
  await page.locator('.g-actions .primary').click();await warning();
  await page.screenshot({path:path.join(artifacts,'temporal-order-warning.png'),fullPage:true});
  let downloads=0;const countDownload=()=>downloads++;page.on('download',countDownload);await page.locator('#download-result').click();await page.waitForTimeout(800);assert.equal(downloads,0);assert.match(await page.locator('#toast').innerText(),/调整时间冲突/);
  console.log('PASS: invalid autosave and manual save retain the last valid graph; warning and export block require adjustment');
  await page.reload();await page.locator('#welcome-drafts').click();await page.locator('.draft-row').first().click();await factForm();assert.equal(await page.locator('#g-fact-time-end-0').inputValue(),'2.5');await warning();
  await page.locator('#g-fact-time-end-0').fill('4.5');await wait(ws=>!(ws.ui_temporal_conflicts||[]).length);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-result').click()]);const file=path.join(artifacts,'temporal-order-item.json');await download.saveAs(file);const output=JSON.parse(fs.readFileSync(file,'utf8'));parseResults(output);assert.equal(output.derived.fact_temporal.fact_1.occurrence.time_ranges[0].end_time,4.5);
  page.off('download',countDownload);console.log('PASS: conflict draft and warning survive reload; correction clears the warning and enables valid JSON export');
  await stage('emotions');await page.locator('.g-node[data-node-id=state_1]').click();await page.locator('#g-state-events').selectOption('event_1');await warning();assert.equal((await state()).graph.links.some(l=>l.from_type==='event'&&l.to_type==='emotion_state'&&l.to_id==='state_1'),false);
  await page.locator('#g-state-events').selectOption([]);await page.locator('#g-state-facts').selectOption('fact_1');await wait(ws=>!(ws.ui_temporal_conflicts||[]).length);
  console.log('PASS: building an event-to-emotion edge checks the complete event end and rolls back invalid links');
  await page.locator('.g-node[data-node-id=state_2]').click();await page.locator('#g-state-end').fill('7');await warning();assert.equal((await state()).graph.emotion_states.find(s=>s.id==='state_2').end_time,10);await page.locator('#g-state-end').fill('10');await wait(ws=>!(ws.ui_temporal_conflicts||[]).length);
  await factForm();const beforeDrag=structuredClone((await state()).graph);await drag('fact','fact_1',2);await warning();assert.deepEqual((await state()).graph,beforeDrag);
  await drag('fact','fact_1',.2);await wait(ws=>fact(ws).time_ranges[0].end_time>4.6&&!(ws.ui_temporal_conflicts||[]).length);
  assert.deepEqual((await state()).records,records);console.log('PASS: moving upstream facts and shortening downstream emotions both revalidate existing edges atomically');
  await stage('evidence');await page.locator('.segment-row').first().click();await page.locator('#segment-end').fill('6');await page.locator('#segment-end').press('Tab');await page.waitForFunction(()=>document.getElementById('time-edit-hint').textContent.includes('时间未保存'));assert.deepEqual((await state()).records,records);
  await page.locator('#download-result').click();await page.waitForTimeout(300);assert.match(await page.locator('#toast').innerText(),/调整时间冲突/);
  await page.locator('#segment-end').fill('3');await page.locator('#segment-end').press('Tab');await page.waitForFunction(()=>document.getElementById('time-edit-hint').textContent==='时间已保存');assert.deepEqual((await state()).records,records);
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(artifacts,'temporal-order-valid.png'),fullPage:true});console.log('PASS: editing evidence times warns persistently, blocks save until corrected and never changes source records on failure');
}catch(error){await page.screenshot({path:path.join(artifacts,'temporal-order-failure.png'),fullPage:true});console.error(error,errors);process.exitCode=1;}finally{await browser.close();}

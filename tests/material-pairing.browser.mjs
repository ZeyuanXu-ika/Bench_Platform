import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { materialResult } from './material-fixture.mjs';
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.join(root,'test-results');
let executablePath=process.env.BROWSER_EXECUTABLE;if(!executablePath&&process.platform==='win32'){const cache=path.join(os.homedir(),'AppData/Local/ms-playwright');for(const name of fs.readdirSync(cache).sort().reverse()){const candidate=path.join(cache,name,'chrome-win64/chrome.exe');if(name.startsWith('chromium-')&&fs.existsSync(candidate)){executablePath=candidate;break;}}}
const browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss());
const state=()=>page.evaluate(async()=>(await(await import('./storage.mjs')).listWorkspaces())[0]);
const file=(id,tag=id)=>({name:`${id}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(materialResult(id,tag)))});
const row=id=>page.locator(`.task-entry[data-item-id="${id}.mp4"]`);
const stage=name=>page.locator(`.g-tab[data-stage=${name}]`).click();
async function wait(predicate){const end=Date.now()+12000;while(Date.now()<end){const ws=await state();if(ws&&predicate(ws))return ws;await page.waitForTimeout(80);}throw new Error('Pairing update timed out');}
async function choosePair(id,payload){const [chooser]=await Promise.all([page.waitForEvent('filechooser'),row(id).locator('.task-pair-button').click()]);await chooser.setFiles(payload);}
async function select(id){await row(id).locator('.task-item').click();await page.waitForFunction(expected=>document.querySelector('.task-item[aria-current=true]')?.textContent.includes(expected),`${id}.mp4`);}
async function checkLayers(tag){
  for(const [name,text] of [['facts',`${tag} fact`],['events',`${tag} event`],['emotions',`${tag} emotion`]]){await stage(name);assert.equal(await page.locator('.g-node-list .g-node').count(),1);assert.ok((await page.locator('.g-node-list').innerText()).includes(text));assert.equal(await page.locator('.g-layer-view .g-time-band').count(),1);}
  await stage('graph');const text=await page.locator('.g-graph-panel').innerText();assert.ok(text.includes(tag));assert.ok(!text.includes(tag==='A'?'B fact':'A fact'));assert.equal(await page.locator('#g-directed-svg [data-node-type=fact]').count(),1);
}
try{
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:8793/');
  const media=fs.readFileSync(path.join(root,'.tools/browser-fixtures/demo-task/media/demo.mp4'));
  await page.locator('#media-input').setInputFiles(['zh01','zh02'].map(id=>({name:`${id}.mp4`,mimeType:'video/mp4',buffer:media})));await page.waitForSelector('.task-entry[data-item-id="zh02.mp4"]');
  await choosePair('zh01',file('zh02','B'));await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('不能配对'));assert.equal((await state()).graph.facts.length,0);assert.equal((await state()).manifest.items.length,2);console.log('PASS: an explicitly selected video rejects the wrong annotation ID without changing either material');
  const [autoChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import-result').click()]);await autoChooser.setFiles(file('zh02','B'));await wait(ws=>ws.records['zh02.mp4'].annotation_source?.file_name==='zh02.json');await checkLayers('B');
  await select('zh01');await stage('facts');assert.equal(await page.locator('.g-node-list .g-node').count(),0);await stage('emotions');assert.equal(await page.locator('.g-node-list .g-node').count(),0);console.log('PASS: automatic matching pairs B with its numbered video while unpaired A remains empty in every upper layer');
  await choosePair('zh01',file('zh01','A'));await wait(ws=>ws.graph.facts.length===2);await checkLayers('A');await select('zh02');await checkLayers('B');assert.ok((await row('zh01').innerText()).includes('zh01.json'));assert.ok((await row('zh02').innerText()).includes('zh02.json'));
  console.log('PASS: two imported files reuse F001/S001 internally without sharing lists, timelines, graphs or subjects');
  await select('zh01');await stage('facts');await page.locator('.g-node-list .g-node').click();await page.locator('#g-fact-text').fill('A edited fact');await wait(ws=>ws.graph.facts.some(node=>node.item_id==='zh01.mp4'&&node.text==='A edited fact'));await select('zh02');await stage('facts');assert.ok((await page.locator('.g-node-list').innerText()).includes('B fact'));assert.ok(!(await page.locator('.g-node-list').innerText()).includes('A edited'));
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-result').click()]);const output=path.join(artifacts,'material-pairing-B.json');await download.saveAs(output);const payload=JSON.parse(fs.readFileSync(output,'utf8'));assert.equal(payload.items.length,1);assert.equal(payload.items[0].id,'zh02.mp4');assert.equal(payload.graph.facts.length,1);assert.equal(payload.graph.facts[0].text,'B fact');assert.equal(payload.items[0].annotation_source.file_name,'zh02.json');console.log('PASS: editing A leaves B unchanged and B exports only its own paired annotations');
  const [batch]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import-result').click()]);await batch.setFiles([file('zh01','A2'),file('zh02','B2')]);await wait(ws=>ws.graph.facts.length===2&&ws.graph.facts.some(node=>node.text==='B2 fact'));await select('zh01');await stage('facts');assert.ok((await page.locator('.g-node-list').innerText()).includes('A2 fact'));await select('zh02');assert.ok((await page.locator('.g-node-list').innerText()).includes('B2 fact'));assert.equal((await state()).manifest.items.length,2);
  await page.reload();await page.locator('#welcome-drafts').click();await page.locator('.draft-row').first().click();await select('zh01');await stage('facts');assert.ok((await page.locator('.g-node-list').innerText()).includes('A2 fact'));await select('zh02');assert.ok((await page.locator('.g-node-list').innerText()).includes('B2 fact'));assert.ok((await row('zh01').innerText()).includes('zh01.json'));assert.deepEqual(errors,[]);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(artifacts,'material-pairing.png'),fullPage:true});console.log('PASS: batch matching replaces each numbered result, and independent pairings survive reload');
}catch(error){await page.screenshot({path:path.join(artifacts,'material-pairing-failure.png'),fullPage:true});console.error(error,errors);process.exitCode=1;}finally{await browser.close();}

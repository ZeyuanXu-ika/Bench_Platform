// Isolated synthetic workspace for visual review; never opens user annotations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..'),phase=process.env.DESIGN_PHASE||'before',out=path.join(root,'test-results','design',phase);fs.mkdirSync(out,{recursive:true});
let executablePath=process.env.BROWSER_EXECUTABLE;if(!executablePath&&process.platform==='win32'){const cache=path.join(os.homedir(),'AppData/Local/ms-playwright');for(const dir of fs.readdirSync(cache).sort().reverse()){const candidate=path.join(cache,dir,'chrome-win64/chrome.exe');if(dir.startsWith('chromium-')&&fs.existsSync(candidate)){executablePath=candidate;break;}}}
const browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1}),errors=[],metrics=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.type()==='beforeunload'?d.accept():d.dismiss());
async function capture(name){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});const data=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyHeight:document.body.scrollHeight,bodyFont:getComputedStyle(document.body).fontFamily,titleSize:document.querySelector('.task-heading h2')?getComputedStyle(document.querySelector('.task-heading h2')).fontSize:null}));metrics.push({name,...data});if(phase!=='before')assert.ok(data.scrollWidth<=data.width+1,`Horizontal overflow: ${name}`);}
try{
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:8793/');await capture('welcome');
  const fixture=JSON.parse(fs.readFileSync(path.join(root,'samples/demo-graph.json'),'utf8'));fixture.graph.status='draft';fixture.graph.links.push({id:'design-change',from_type:'emotion_state',from_id:'state_1',to_type:'emotion_state',to_id:'state_2',type:'transitions_to',content_refs:[{node_type:'event',node_id:'event_1',relation:'influences',note:'Synthetic example for interface review.'}]});
  await page.locator('#result-input').setInputFiles({name:'design-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.waitForSelector('#workspace:not([hidden])');
  const mediaDir=path.join(root,'.tools/browser-fixtures/demo-task');if(fs.existsSync(mediaDir)){await page.locator('#folder-input').setInputFiles(mediaDir);await page.waitForFunction(()=>document.getElementById('video').readyState>=2);await page.evaluate(()=>{document.getElementById('video').currentTime=1.5;});}
  await page.locator('#toast').waitFor({state:'hidden',timeout:15000});
  for(const stage of ['evidence','facts','events','emotions','graph']){
    await page.locator(`.g-tab[data-stage=${stage}]`).click();
    if(stage==='evidence'&&await page.locator('.segment-row').count())await page.locator('.segment-row').first().click();
    if(stage==='facts')await page.locator('.g-node[data-node-id=fact_1]').click();
    if(stage==='events')await page.locator('.g-node[data-node-id=event_1]').click();
    if(stage==='emotions'){await page.locator('.g-node[data-node-id=state_1]').click();await page.locator('.g-edge-select').first().click();}
    if(stage==='graph')await page.locator('#g-directed-svg [data-node-id=state_1]').dispatchEvent('click');
    await capture(stage);
  }
  for(const [prefix,width,height] of [['laptop',1280,800],['wide',1920,1080]]){await page.setViewportSize({width,height});for(const stage of ['evidence','facts','events','emotions','graph']){await page.locator(`.g-tab[data-stage=${stage}]`).click();await capture(prefix+'-'+stage);}}
  await page.locator('#help-button').click();await page.screenshot({path:path.join(out,'desktop-help.png')});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({phase,metrics,pageErrors:errors},null,2));console.log(`PASS ${phase}: ${metrics.length} views captured; no application errors`);
}finally{await browser.close();}

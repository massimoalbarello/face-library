import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright-core');
const [base,fixtures,rotations,out,credentialPath]=process.argv.slice(2);
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname)&&process.env.ALLOW_REMOTE_TESTS!=='1')throw Error('Use a disposable test library');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();page.setDefaultTimeout(20000);
const failures=[];page.on('pageerror',e=>failures.push(e.message));
const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
await cdp.send('WebAuthn.addCredential',{authenticatorId,credential:JSON.parse(await readFile(credentialPath,'utf8'))});
async function api(path,method='GET',body){return page.evaluate(async ({path,method,body})=>{
 const r=await fetch(path,{method,headers:{'X-Requested-With':'FaceLibrary','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};
},{path,method,body});}
async function settled(){for(let i=0;i<200;i++){const s=await api('/api/status');if(s.data.pending===0)return;await new Promise(r=>setTimeout(r,100));}throw Error('Processing timeout');}
async function upload(files){
 const before=(await api('/api/photos')).data.items.map(p=>p.id);
 await page.getByRole('button',{name:'Add photos',exact:true}).click();
 const posted=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/photos?'));
 await page.locator('#files').setInputFiles(files);await posted;
 await page.waitForFunction(()=>!document.querySelector('#upload-progress progress')&&document.querySelector('#toast')?.textContent.includes('uploaded'));
 await settled();
 return (await api('/api/photos')).data.items.filter(p=>!before.includes(p.id));
}
let photos=[];
try{
 await page.goto(base);await page.getByRole('button',{name:'Sign in with passkey',exact:true}).click();await page.getByRole('heading',{name:'Photos',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Take a photo',exact:true}).isVisible(),false);
 await page.getByRole('button',{name:'Add photos',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Take a photo',exact:true}).isVisible(),true);
 await page.screenshot({path:resolve(out,'upload-dialog.png')});
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 const [first]=await upload([join(fixtures,'lena.jpg')]);photos.push(first.id);
 const [second]=await upload([join(fixtures,'lena-darker.jpg')]);photos.push(second.id);
 let face=(await api('/api/faces/'+first.faces[0].id)).data;
 const firstView=face.views.find(v=>v.photo_id===first.id).id;
 const secondView=face.views.find(v=>v.photo_id===second.id).id;
 assert.equal(face.cover,firstView,'Default preview must be the first detected view');
 assert.equal((await api('/api/faces')).data.items.find(f=>f.id===face.id).cover,firstView);
 assert.equal(await page.locator('#upload-progress progress').count(),0);
 assert.equal(await page.getByText('Uploads complete',{exact:false}).count(),0);
 await page.screenshot({path:resolve(out,'photos.png'),fullPage:true});
 await page.goto(base+'/#face/'+face.id);
 await page.getByRole('heading',{name:'Face '+face.id,exact:true}).waitFor();
 assert.ok((await page.locator('.face-title-row img').getAttribute('src')).endsWith('/'+firstView));
 await page.locator(`[data-preview="${secondView}"]`).click();
 await page.waitForFunction(id=>document.querySelector('.face-title-row img')?.getAttribute('src')===`/assets/views/${id}`,secondView);
 await page.reload();await page.getByRole('heading',{name:'Face '+face.id,exact:true}).waitFor();
 assert.ok((await page.locator('.face-title-row img').getAttribute('src')).endsWith('/'+secondView));
 assert.equal((await api('/api/faces')).data.items.find(f=>f.id===face.id).cover,secondView);
 await page.screenshot({path:resolve(out,'face-preview.png'),fullPage:true});
 await page.getByRole('link',{name:/^Photos/}).first().click();
 const [tilted]=await upload([join(rotations,'tilt-90.jpg')]);photos.push(tilted.id);
 assert.equal(tilted.view_count,1);assert.equal(tilted.faces[0].id,face.id,'Tilted view must join the same person');
 assert.equal((await api('/api/faces/'+face.id)).data.cover,secondView,'New uploads cannot replace the chosen preview');
 const [other]=await upload([join(fixtures,'messi.jpg')]);photos.push(other.id);
 const otherFace=(await api('/api/faces/'+other.faces[0].id)).data;
 assert.equal((await api(`/api/faces/${face.id}/cover`,'PUT',{view_id:otherFace.views[0].id})).status,400,'Another person cannot be used as the preview');
 const moved=await api('/api/views/move','POST',{ids:[secondView],target:0});assert.equal(moved.status,200);
 assert.equal((await api('/api/faces/'+face.id)).data.cover,firstView,'Moving a cover must select the oldest remaining view');
 await api(`/api/faces/${moved.data.id}/merge`,'POST',{target:face.id});
 assert.equal((await api('/api/faces/'+face.id)).data.cover,firstView,'Merge must retain the target preview');
 await api(`/api/faces/${face.id}/cover`,'PUT',{view_id:secondView});
 await api(`/api/photos/${second.id}`,'DELETE');photos=photos.filter(id=>id!==second.id);
 assert.equal((await api('/api/faces/'+face.id)).data.cover,firstView,'Deleting the cover photo must fall back to the earliest view');
 const [mixed]=await upload([join(rotations,'mixed-orientations.jpg')]);photos.push(mixed.id);assert.equal(mixed.view_count,2);
 const [blank]=await upload([join(fixtures,'no-face.png')]);photos.push(blank.id);assert.equal(blank.view_count,0);
 await api(`/api/photos/${blank.id}/retry`,'POST');await settled();assert.equal((await api('/api/photos/'+blank.id)).data.views.length,0);
 // An invalid upload keeps an actionable error, without leaving a completed progress bar.
 await page.getByRole('button',{name:'Add photos',exact:true}).click();
 await page.locator('#files').setInputFiles({name:'broken.jpg',mimeType:'image/jpeg',buffer:Buffer.from('not a JPEG')});
 await page.getByRole('button',{name:'Dismiss upload errors',exact:true}).waitFor();
 assert.equal(await page.locator('#upload-progress progress').count(),0);
 await page.getByRole('button',{name:'Dismiss upload errors',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Add photos',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 await page.screenshot({path:resolve(out,'upload-mobile.png')});
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 assert.deepEqual(failures,[]);
 console.log('PASS upload dialog, progress cleanup/errors, first preview, custom preview, refresh, new uploads, invalid selection, move/merge/delete fallback, tilted matching, mixed orientations, mobile layout');
}finally{
 for(const id of photos)await api('/api/photos/'+id,'DELETE').catch(()=>{});
 const saved=(await cdp.send('WebAuthn.getCredentials',{authenticatorId})).credentials[0];
 if(saved)await writeFile(credentialPath,JSON.stringify(saved),{mode:0o600});
 await browser.close();
}

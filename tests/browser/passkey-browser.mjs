import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright-core');
const [base, fixture, video, out] = process.argv.slice(2);
if (!base || !out) throw Error('Usage: BASE_URL IMAGE Y4M OUTPUT_DIR [--returning]. Use only a disposable workspace.');
// Tests register an owner. Never run against the user-facing deployment.
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname) && process.env.ALLOW_REMOTE_TESTS !== '1') throw Error('Use a disposable staging app for owner registration tests');
const returning = process.argv.includes('--returning');
await mkdir(out, {recursive: true});
const authenticator = { protocol:'ctap2', transport:'internal', hasResidentKey:true, hasUserVerification:true, isUserVerified:true, automaticPresenceSimulation:true };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,
  args:['--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${resolve(video)}`] });
const failures=[];
const context=await browser.newContext({ viewport:{width:1440,height:1000}, permissions:['camera'] });
const page=await context.newPage();
page.setDefaultTimeout(20000);
page.on('pageerror', e=>failures.push(e.message));
page.on('response', r=>{if(r.status()>=500)failures.push(`${r.status()} ${r.url()}`);});
const cdp=await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
let active=(await cdp.send('WebAuthn.addVirtualAuthenticator',{options:authenticator})).authenticatorId;
const api=async (path, method='GET', body)=>page.evaluate(async ({path,method,body})=>{
  const r=await fetch(path,{method,headers:{'X-Requested-With':'FaceLibrary','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
},{path,method,body});
let created=[];
async function photosReady(){
  for(let i=0;i<200;i++){
    const photos=(await api('/api/photos')).body.items;
    if(photos.every(p=>!['processing','queued'].includes(p.status)))return photos;
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Photos did not finish processing');
}
try {
  assert.equal((await fetch(base+'/api/photos')).status,401);
  assert.equal((await fetch(base+'/assets/photos/1/original')).status,401);
  assert.equal((await fetch(base+'/api/photos',{headers:{Authorization:'Bearer obsolete-access-key',Cookie:'face_session=obsolete'}})).status,401);
  const legacy=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FaceLibrary'},body:JSON.stringify({key:'old-key'})});
  assert.equal(legacy.status,404,'Old access-key login must be gone');
  await page.goto(base);
  assert.equal(await page.locator('input[type=password]').count(),0);
  if(returning){
    const saved=JSON.parse(await readFile(resolve(out,'test-credential.json'),'utf8'));
    await cdp.send('WebAuthn.addCredential',{authenticatorId:active,credential:saved});
    await page.getByRole('button',{name:'Sign in with passkey',exact:true}).click();
  } else {
    await page.getByRole('button',{name:'Create your passkey',exact:true}).waitFor();
    await page.screenshot({path:resolve(out,'signup-desktop.png'),fullPage:true});
    const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const phone=await mobile.newPage();await phone.goto(base);
    await phone.getByRole('button',{name:'Create your passkey',exact:true}).waitFor();
    assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth),390);
    await phone.screenshot({path:resolve(out,'signup-mobile.png'),fullPage:true});await mobile.close();
    await page.getByRole('button',{name:'Create your passkey',exact:true}).click();
  }
  await page.getByRole('heading',{name:'Photos',exact:true}).waitFor();
  assert.equal((await api('/api/status')).status,200);
  assert.equal((await api('/api/owner')).body.ownerRegistered,true);
  console.log(returning?'PASS returning passkey after restart':'PASS real WebAuthn registration and Better Auth session');
  if(returning && process.env.CHECK_PERSISTENCE){
    const previous=JSON.parse(await readFile(resolve(out,'persisted-photo.json'),'utf8'));
    const photo=(await api(`/api/photos/${previous.id}`)).body;
    assert.equal(photo.status,'ready');
    assert.equal(photo.views[0].name,'Test person');
    created.push(previous.id);
    console.log('PASS photo and face name preserved across redeployment');
  }

  const outsider=await browser.newContext();const other=await outsider.newPage();await other.goto(base);
  await other.getByRole('button',{name:'Sign in with passkey',exact:true}).waitFor();
  const forbidden=await other.request.get(base+'/api/auth/passkey/generate-register-options');
  assert.equal(forbidden.status(),403,'A second visitor cannot claim this owner');
  assert.equal((await fetch(base+'/api/auth/passkey/generate-register-options',{headers:{Origin:'https://evil.example'}})).status,403);
  await outsider.close();

  if(!returning){
    await page.getByRole('link',{name:'Settings',exact:true}).click();
    await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
    const primary=active;
    await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId:primary});
    active=(await cdp.send('WebAuthn.addVirtualAuthenticator',{options:authenticator})).authenticatorId;
    await page.getByRole('button',{name:'Add a passkey',exact:true}).click();
    await page.getByText('Passkey added.',{exact:true}).waitFor();
    assert.equal((await api('/api/auth/passkey/list-user-passkeys')).body.length,2);
    console.log('PASS authenticated backup passkey registration');
  }
  const credentials=(await cdp.send('WebAuthn.getCredentials',{authenticatorId:active})).credentials;
  assert.equal(credentials.length,1);
  await writeFile(resolve(out,'test-credential.json'),JSON.stringify(credentials[0]),{mode:0o600});

  await page.getByRole('link',{name:/^Photos/}).click();
  await page.getByRole('button',{name:'Add photos',exact:true}).click();
  await page.locator('#files').setInputFiles(resolve(fixture));
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('uploaded') && !document.querySelector('#upload-progress progress'));
  let photos=await photosReady();created.push(photos[0].id);
  assert.equal(photos[0].status,'ready');assert.ok(photos[0].view_count>=1);
  const original=await page.request.get(`${base}/assets/photos/${photos[0].id}/original`);
  assert.deepEqual(await original.body(),await readFile(fixture));
  assert.equal((await fetch(`${base}/assets/photos/${photos[0].id}/original`)).status,401);

  await page.getByRole('button',{name:'Add photos',exact:true}).click();
  await page.getByRole('button',{name:'Take a photo',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#camera-capture').disabled);
  await page.getByRole('button',{name:'Capture',exact:true}).click();
  await page.getByRole('button',{name:'Use photo',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('uploaded') && !document.querySelector('#upload-progress progress'));
  photos=await photosReady();created.push(photos[0].id);
  assert.ok(photos[0].filename.startsWith('camera-'));assert.ok(photos[0].view_count>=1);
  const faceId=photos[0].faces[0].id;
  assert.equal((await api(`/api/faces/${faceId}`,'PATCH',{name:'Test person'})).status,200);
  console.log('PASS passkey-authorized upload, camera, face extraction, protected originals and naming');

  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Sign in with passkey',exact:true}).waitFor();
  assert.equal((await api('/api/photos')).status,401);
  await page.getByRole('button',{name:'Sign in with passkey',exact:true}).click();
  await page.getByRole('heading',{name:'Photos',exact:true}).waitFor();
  assert.equal((await api('/api/photos')).body.items.length,photos.length);
  console.log('PASS sign out invalidates the session; passkey sign-in restores the library');
  if(process.env.LARGE_IMAGE){
    await page.getByRole('button',{name:'Add photos',exact:true}).click();
    await page.locator('#files').setInputFiles(resolve(process.env.LARGE_IMAGE));
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('uploaded') && !document.querySelector('#upload-progress progress'));
    const large=(await photosReady())[0];created.push(large.id);
    assert.equal(large.status,'ready');
    console.log('PASS large photo processed with Better Auth and face models loaded');
  }
  if(process.env.PERSIST_PHOTO){
    const id=created.shift();
    await writeFile(resolve(out,'persisted-photo.json'),JSON.stringify({id}));
  }
  for(const id of created)assert.equal((await api(`/api/photos/${id}`,'DELETE')).status,200);
  created=[];
  assert.deepEqual(failures,[]);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  const saved=(await cdp.send('WebAuthn.getCredentials',{authenticatorId:active})).credentials[0];
  await writeFile(resolve(out,'test-credential.json'),JSON.stringify(saved),{mode:0o600});
  console.log('PASS auth boundary checks and test-photo cleanup');
} finally { await browser.close(); }

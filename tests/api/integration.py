#!/usr/bin/env python3
"""Exercise real HTTP, files, inference, and grouping. Use a disposable library.
Usage: python3 tests/integration.py URL STORAGE_STATE_JSON FIXTURE_DIR [--cleanup]
Fixtures: lena.jpg, lena-darker.jpg, messi.jpg, two-people.jpg, no-face.png
"""
import sys,json,time,urllib.request,urllib.error,http.cookiejar,pathlib
base,state_file,fixture_dir=sys.argv[1:4]
state=json.loads(pathlib.Path(state_file).read_text());fixtures=pathlib.Path(fixture_dir)
session_cookie="; ".join(c["name"]+"="+c["value"] for c in state["cookies"])
jar=http.cookiejar.CookieJar();client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
created=[]
def req(path,method='GET',data=None,expected=200,auth=True,headers=None):
    hs={'X-Requested-With':'FaceLibrary','Content-Type':'application/octet-stream','User-Agent':'FaceLibrary-Integration/1.0',**(headers or {})}
    if auth:hs['Cookie']=session_cookie
    if isinstance(data,dict):data=json.dumps(data).encode();hs['Content-Type']='application/json'
    rq=urllib.request.Request(base+path,data=data,method=method,headers=hs)
    try:
        response=(client.open(rq,timeout=120) if auth else urllib.request.urlopen(rq,timeout=120));code=response.status;raw=response.read()
    except urllib.error.HTTPError as e:code=e.code;raw=e.read()
    assert code==expected,(path,code,raw[:500])
    try:return json.loads(raw)
    except:return raw
req('/api/photos',expected=401,auth=False)
assert req('/api/auth/get-session')['user']['id']=='face-library-owner'
assert req('/api/status')['ready']
req('/api/settings','POST',{'threshold':1.01},400)
req('/api/settings','POST',{'threshold':.363},headers={'Origin':'https://evil.example'},expected=403)
req('/api/settings','POST',{'threshold':.363})
req('/api/photos?name=bad.jpg','POST',b'not an image',415)
def upload(name):
    photo=req('/api/photos?name='+name,'POST',(fixtures/name).read_bytes(),201);created.append(photo['id']);return photo['id']
ids=[upload(n) for n in ['lena.jpg','lena-darker.jpg','messi.jpg','two-people.jpg','no-face.png']]
for _ in range(120):
    if req('/api/status')['pending']==0:break
    time.sleep(.5)
else:raise AssertionError('processing timed out')
photos=[req('/api/photos/'+str(id)) for id in ids]
assert all(p['status']=='ready' for p in photos),[(p['filename'],p['error']) for p in photos]
assert len(photos[0]['views'])==1 and len(photos[1]['views'])==1
assert len(photos[2]['views'])>=1 and len(photos[3]['views'])>=2
assert photos[4]['views']==[]
a=photos[0]['views'][0];a2=photos[1]['views'][0];other=photos[2]['views'][0]
assert a['face_id']==a2['face_id'],'Same person should match'
assert a['face_id']!=other['face_id'],'Different people should stay separate'
assert len(set(v['face_id'] for v in photos[3]['views']))==len(photos[3]['views']),'Distinct views within one photo must not auto-merge'
assert req(f'/assets/photos/{ids[0]}/original')==(fixtures/'lena.jpg').read_bytes()
req(f'/assets/views/{a["id"]}',auth=False,expected=401)
face=req('/api/faces/'+str(a['face_id']));assert any(v['photo_id']==ids[0] for v in face['views'])
req('/api/faces/'+str(a['face_id']),'PATCH',{'name':'Sample person'})
new=req('/api/views/move','POST',{'ids':[a2['id']],'target':0})['id']
req('/api/settings','POST',{'threshold':0})
req('/api/regroup','POST',{})
assert req('/api/photos/'+str(ids[1]))['views'][0]['face_id']==new,'Split must survive regrouping'
assert req('/api/photos/'+str(ids[0]))['views'][0]['face_id']==a['face_id'],'Named face must survive regrouping'
req('/api/faces/'+str(new)+'/merge','POST',{'target':a['face_id']})
assert req('/api/photos/'+str(ids[1]))['views'][0]['face_id']==a['face_id']
req('/api/views/move','POST',{'ids':[other['id']],'target':a['face_id']})
assert req('/api/photos/'+str(ids[2]))['views'][0]['face_id']==a['face_id']
before=req('/api/photos/'+str(ids[0]))['views'][0]['face_id']
req('/api/views/move','POST',{'ids':[a['id'],999999999],'target':0},404)
assert req('/api/photos/'+str(ids[0]))['views'][0]['face_id']==before,'Failed edits must roll back'
req('/api/settings','POST',{'threshold':.363})
if '--cleanup' in sys.argv:
    for id in created:req('/api/photos/'+str(id),'DELETE')
req('/api/auth/sign-out','POST',{})
req('/api/photos',expected=401)
print('PASS authentication, CSRF, uploads, original bytes, inference, zero/multiple faces, nearest-neighbor grouping, links, names, split/move/merge, fixed edits, rollback, logout'+(', cleanup' if '--cleanup' in sys.argv else ''))

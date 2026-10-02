"""Native voice settings preserve, cancel and explicitly clear a synthetic key."""
import json,time,urllib.request,http.cookiejar
import native_ui as u
jar=http.cookiejar.CookieJar();api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,data=None):
    req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with api.open(req,timeout=30) as r:return json.load(r)
def visible(label):
    for n in u.layout():
        if n.get('id')==label or n.get('text')==label or n.get('hint')==label:
            x,y,r,b=map(int,u.re.findall(r'\d+',n['bounds']))
            if r>x and b>y and 180<y<2530:return n
    return None
def reveal(label):
    for _ in range(12):
        n=visible(label)
        if n:return n
        u.run('shell','uitest','uiInput','swipe','1290','2300','1290','1000','500');time.sleep(.3)
    raise AssertionError('Could not reveal '+label)
def click(label):
    u.run('shell','uitest','uiInput','click',*u.center(reveal(label)));time.sleep(.6)
def field(label,value):
    reveal(label);u.type_at(label,value,True)
def open_settings():
    u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.click('Settings')
call('/api/login',{'password':'native-test-password'})
original=call('/api/settings/voice')
assert not original['has_tts_api_key'],'Do not replace an existing unknown credential'
try:
    open_settings();field('OpenAI-compatible API base URL','http://127.0.0.1:19991/v1');field('voice-key','native-fixture-key-not-a-real-credential');click('Save')
    saved=call('/api/settings/voice');assert saved['has_tts_api_key'] and saved['tts_base_url']=='http://127.0.0.1:19991/v1'
    open_settings();key=reveal('voice-key');assert key.get('text','')=='' and key.get('hint')=='Saved API key (leave blank to keep)'
    field('OpenAI-compatible API base URL','http://127.0.0.1:19992/v1');click('Cancel')
    assert call('/api/settings/voice')['tts_base_url']==saved['tts_base_url']
    open_settings();reveal('voice-key');click('Save')
    assert call('/api/settings/voice')['has_tts_api_key'],'Blank field erased saved key'
    open_settings();label=reveal('Clear saved API key');_,y,_,b=map(int,u.re.findall(r'\d+',label['bounds']))
    switch=next(n for n in u.layout() if n.get('type')=='Toggle' and y<=int(u.center(n)[1])<=b)
    u.run('shell','uitest','uiInput','click',*u.center(switch));click('Save')
    assert not call('/api/settings/voice')['has_tts_api_key']
    open_settings();key=reveal('voice-key');assert key.get('hint')=='Enter API key'
    u.capture('../../../artifacts/harmonyos/native-voice-settings.png')
    print('PASS native save, masked empty reopen, Cancel, blank key preservation and explicit clear across restarts')
finally:
    call('/api/settings/voice',dict(original,tts_api_key='',tts_api_key_clear=True))

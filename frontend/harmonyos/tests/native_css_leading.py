"""Measure CSS line-height through actual ArkUI text geometry.

Requires the dedicated css-leading Docker fixture selected in the test emulator.
Never sends prompts. Restores the original CSS even when an assertion fails.
"""
import argparse,json,os,re,time
from pathlib import Path
import native_ui as u

def rect(n):return tuple(map(int,re.findall(r'\d+',n['bounds'])))
def css(value):
    u.click('Sessions');u.click('Settings');u.type_at('custom-css',value,True)
    warnings=[n.get('text','') for n in u.layout() if n.get('text','').startswith('Unsupported')]
    u.click('Close');time.sleep(.8)
    assert not warnings,warnings

def measure():
    rows=[n for n in u.layout() if n.get('type')=='Text' and 'Leading one' in n.get('text','')]
    assert len(rows)==1,rows
    bounds=rect(rows[0]);return bounds[3]-bounds[1]

if __name__=='__main__':
    assert os.environ.get('CODOXEAR_HDC_TARGET') == '127.0.0.1:15558', 'Use only the dedicated test emulator'
    measure()  # Require the synthetic transcript before changing appearance.
    p=argparse.ArgumentParser();p.add_argument('evidence');args=p.parse_args()
    evidence=Path(args.evidence);evidence.mkdir(parents=True,exist_ok=True)
    u.click('Sessions');u.click('Settings');original=u.node('custom-css').get('text','');u.click('Close')
    result={}
    try:
        for name,declarations in [('18px','font-size:18px;line-height:18px;'),('36px','font-size:18px;line-height:36px;'),('reverse','line-height:36px;font-size:18px;'),('percent','font-size:18px;line-height:200%;')]:
            css('.msg { '+declarations+' }');result[name]=measure()
            u.capture(evidence/(name+'.png'))
        assert abs(result['36px']-2*result['18px'])<=2,result
        assert result['36px']==result['reverse']==result['percent'],result
        (evidence/'geometry.json').write_text(json.dumps(result,indent=2)+'\n')
        print('PASS actual native text heights:',result)
    finally:css(original)

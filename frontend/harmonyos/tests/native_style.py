"""Actual native CSS theme mutation, mode matching and private preference persistence.
Start logged in with the Settings panel open. Restores the fixture's default theme.
"""
import time
import native_ui as u
CSS=':root { --panel: #dbeafe; --accent-strong: #2563eb; --radius-control: 14px; }\n:root[data-mode="dark"] { --panel: #172554; --accent-strong: #60a5fa; }'
u.click('light')
u.type_at('custom-css',CSS,True)
assert u.node('custom-css').get('text') == CSS
u.capture('../../../artifacts/harmonyos/native-css-light.png')
u.click('dark')
u.capture('../../../artifacts/harmonyos/native-css-dark.png')
u.run('shell','aa','force-stop','com.codoxear.mobile')
u.login('http://127.0.0.1:19744')
u.click('Settings')
assert u.node('custom-css').get('text') == CSS
u.capture('../../../artifacts/harmonyos/native-css-restored.png')
u.type_at('custom-css','',True)
u.click('light')
print('PASS: custom CSS text, light/dark controls and restart persistence; inspect screenshots for native color results')

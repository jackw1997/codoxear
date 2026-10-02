"""Native message CSS selector rendering. Start at the logged-in catalog."""
import time
import native_ui as u
u.click('Native verified session')
u.click('Sessions')
u.click('Settings')
u.type_at('custom-css','.msg { padding: 18px; font-size: 18px; line-height: 1.5; border-radius: 4px; }\n.msg.user { background: #dbeafe; color: #1e3a8a; }\n.msg.assistant { background: #dcfce7; color: #14532d; border-width: 2px; border-color: #16a34a; }',True)
assert not any('Unsupported' in n.get('text','') and n.get('type')=='Text' and 'Unsupported rules' not in n.get('text','') for n in u.layout())
u.click('Close')
u.type_at('message-input','Native component CSS verification',True)
u.click('Send');time.sleep(4)
u.capture('../../../artifacts/harmonyos/native-css-messages.png')
print('PASS: component CSS accepted by actual native UI; inspect captured colors, border, spacing and font')

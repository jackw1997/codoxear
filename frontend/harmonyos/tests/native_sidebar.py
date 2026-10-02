"""Exercise visible sidebar metadata, actions, footer and keyboard navigation."""
import time,re
import native_ui as u

def key(code):
    u.run('shell','uitest','uiInput','keyEvent',str(code));time.sleep(.5)
def open_sidebar():
    if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
def swipe(label,start,end):
    row=next(n for n in u.layout() if n.get('text')==label and n.get('id')!='chat-keyboard');y=u.center(row)[1]
    u.run('shell','uitest','uiInput','swipe',str(start),y,str(end),y,'400');time.sleep(.6)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
open_sidebar();u.node('NOW');u.node('Help');u.node('Settings');u.node('Log out')
# Visible footer shortcuts retain scoped hints after the width/layout change.
key(2022);u.node('hint-h');time.sleep(5);u.node('hint-h');key(2024);u.node('Close');key(2019)
open_sidebar();u.node('Help');u.click('Notification settings');u.node('Appearance');u.click('Close')
open_sidebar();u.select_session('Native verified session');u.click('Sessions')
swipe('Native verified session',1050,430);u.node('Edit');u.node('Duplicate')
u.capture('../../../artifacts/harmonyos/native-sidebar-swipe-final.png')
u.click('Edit');u.node('Session name');u.click('Close')
# Reveal the opposite action and cancel the actual confirmation.
open_sidebar();swipe('Native verified session',450,1050)
u.click('Delete');u.node('Delete session?');u.click('Cancel')
u.node('Native verified session')
# Collapse swipe actions before capturing the ordinary sidebar.
open_sidebar();u.select_session('Native verified session');u.click('Sessions')
u.capture('../../../artifacts/harmonyos/native-sidebar-final.png')
print('PASS: sidebar footer, Help keyboard hint/direct close, notifications shortcut, Edit and Duplicate reveal, Edit close, Delete cancellation and selection')

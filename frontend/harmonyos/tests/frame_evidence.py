"""Lay out unaltered emulator captures inside clearly labeled schematic frames."""
from pathlib import Path
import base64
root=Path(__file__).resolve().parents[4]/'artifacts/harmonyos'
def shot(name):return 'data:image/png;base64,'+base64.b64encode((root/name).read_bytes()).decode()
css='''*{box-sizing:border-box}body{margin:0;background:#eeebe5;color:#302c28;font-family:-apple-system,sans-serif;padding:44px}h1{margin:0 0 10px;font-size:32px}p{margin:0 0 26px;color:#655f55;font-size:18px}.row{display:flex;gap:52px;align-items:flex-start}.device{position:relative;border:10px solid #292929;border-radius:32px;background:#292929;box-shadow:0 16px 32px #302a2525}.device:after{content:"";position:absolute;right:-14px;top:90px;width:4px;height:70px;border-radius:0 3px 3px 0;background:#555}.device img{width:100%;display:block;border-radius:22px}h2{margin:0 0 14px;font-size:23px}small{display:block;font-size:15px;color:#686157;line-height:1.6;margin-top:16px}footer{font-size:17px;line-height:1.7;margin-top:32px;color:#60584e}'''
html=f'''<!doctype html><meta charset="utf-8"><style>{css}</style><h1>Codoxear · Pura X Max 实际运行记录</h1><p>原生 ArkUI · HarmonyOS 6.1.1 模拟器 · 同一会话在折叠前后</p><div class="row"><section style="width:940px"><h2>展开内屏 · 会话列表 + 聊天</h2><div class="device"><img src="{shot('pura-x-max-inner-chat.png')}"></div><small>原始截图 2584 × 1828 px · 保持原始宽高比</small></section><section style="width:470px"><h2>折叠外屏 · 单栏聊天</h2><div class="device"><img src="{shot('pura-x-max-outer-chat.png')}"></div><small>原始截图 1264 × 1848 px · 保持原始宽高比</small></section></div><footer>画面来自安装运行后的模拟器截屏；外部黑色机身为边框示意，不是实机照片或官方外观图。<br>使用隔离测试会话（无真实模型推理）。这是开发进度记录，尚未通过完整功能与像素一致性验收。</footer>'''
(root/'pura-x-max-chat-framed.html').write_text(html)
html=f'''<!doctype html><meta charset="utf-8"><style>{css}</style><h1>Codoxear · 原生文件页面</h1><p>Pura X Max 展开内屏 · 从聊天的文件入口打开 example.py</p><div class="device" style="width:940px"><img src="{shot('pura-x-max-inner-file.png')}"></div><footer>实际模拟器截屏，外部机身为边框示意。文件来自隔离测试容器。<br>原生编辑器仍在完善；本图不表示已达到网页版完整编辑能力。</footer>'''
(root/'pura-x-max-file-framed.html').write_text(html)
print(root)
items=[('原生代码查看与保存','native-editor-syntax.png'),('原生 PDF 搜索高亮','native-pdf-search.png'),('Git 文件增删差异','native-git-diff.png'),('消息队列编辑','native-queue-edited.png')]
html=f'<!doctype html><meta charset="utf-8"><style>{css}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:32px}}h2{{font-size:22px}}.device{{border-width:8px;border-radius:26px}}.device img{{border-radius:18px}}</style><h1>Codoxear · 原生功能实测</h1><p>Pura X Max 展开内屏 · 实际模拟器截图，黑色机身为边框示意</p><div class="grid">'
for title,name in items:html+=f'<section><h2>{title}</h2><div class="device"><img src="{shot(name)}"></div></section>'
html+='</div><footer>界面均运行在原生 ArkUI；PDF 使用系统 PDFKit。数据来自隔离测试容器。<br>这是持续开发的实测记录，完整功能、真实模型和像素一致性验收仍在推进。</footer>'
(root/'native-features-framed.html').write_text(html)

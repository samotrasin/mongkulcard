# Makes the trimmed Chinese web fonts in public/img/fonts from the couple's original 创艺 .TTF files (GB-encoded, so the cmap is rebuilt as Unicode).
# Usage: python3 tools/zh-font-subset.py <original.ttf> public/img/fonts/cy-hupo.woff2 "<every Chinese character on the invitation>"
# Re-run it whenever the Chinese text changes. The original .TTF files are NOT kept in this repo.
import sys,re
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import cmap_format_4
from fontTools import subset
src,out,text=sys.argv[1],sys.argv[2],sys.argv[3]
t=TTFont(src)
st=[x for x in t['cmap'].tables if x.platformID==3][0]
m={}
for code,g in st.cmap.items():
    b=code.to_bytes(2,'big') if code>255 else bytes([code])
    try:u=b.decode('gbk')
    except: continue
    if len(u)==1: m[ord(u)]=g
c=cmap_format_4(4);c.platformID=3;c.platEncID=1;c.language=0;c.cmap=m
t['cmap'].tables=[c]
# clean names to plain ascii so browsers accept it
for n in list(t['name'].names):
    if n.platformID==3 and n.platEncID!=1: t['name'].names.remove(n)
fam='CTHuPoSF' if 'HuPo' in str(t['name'].getName(1,1,25,0) or '') else None
t.save(out+'.tmp.ttf')
opts=subset.Options();opts.flavor=out.rsplit('.',1)[1] if out.endswith('woff2') else None
opts.name_IDs=['*'];opts.name_languages=['*'];opts.notdef_outline=True;opts.layout_features=['*']
f=subset.load_font(out+'.tmp.ttf',opts);s=subset.Subsetter(opts);s.populate(text=text);s.subset(f);subset.save_font(f,out,opts)

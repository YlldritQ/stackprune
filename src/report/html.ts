import type { ScanResult } from '../types.js';
import { summarize } from './format.js';

/** A single self-contained HTML file: no network requests, works offline, safe to attach to a CI run. */
export function renderHtml(r: ScanResult): string {
  const s = summarize(r);
  const data = {
    generatedAt: r.generatedAt,
    currency: r.currency,
    usageWindow: r.usageWindow,
    targets: r.targets.map((t) => ({ name: t.name, group: t.group, files: t.files })),
    summary: s,
    unknownHosts: r.unknownHosts.slice(0, 100),
    integrations: r.integrations.map((i) => ({
      id: i.vendor.id,
      name: i.vendor.name,
      category: i.vendor.category,
      url: i.vendor.url,
      paid: i.vendor.paid,
      status: i.status,
      verdict: i.verdict,
      reasons: i.reasons,
      cost: i.cost,
      owner: i.owner,
      purpose: i.purpose,
      codeFiles: i.codeFiles,
      removalFiles: i.removalFiles,
      calls: i.usage?.calls,
      ai: i.introducedWithAI,
      introducedAt: i.introducedAt,
      lastTouchedAt: i.lastTouchedAt,
      targets: [...new Set(i.hits.map((h) => h.target))],
      evidence: i.hits.flatMap((h) => h.evidence.slice(0, 40).map((e) => ({ t: h.target, k: e.kind, f: e.file, l: e.line, d: e.detail, dev: !!e.dev }))),
    })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stackprune report</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1b1b1a;--muted:#6b6a66;--line:#e6e4df;--cut:#c2410c;--cut-bg:#fff1e8;--review:#a16207;--review-bg:#fdf6e3;--keep:#15803d;--keep-bg:#ecfaf0;--ai:#7c3aed;--ai-bg:#f3efff;--accent:#1b1b1a;--chip:#f0efeb}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141413;--panel:#1d1d1b;--ink:#ecebe6;--muted:#9c9a93;--line:#2e2d2a;--cut:#fb923c;--cut-bg:#2a1a10;--review:#facc15;--review-bg:#272111;--keep:#4ade80;--keep-bg:#112417;--ai:#a78bfa;--ai-bg:#1f1830;--accent:#ecebe6;--chip:#262624}}
:root[data-theme=dark]{--bg:#141413;--panel:#1d1d1b;--ink:#ecebe6;--muted:#9c9a93;--line:#2e2d2a;--cut:#fb923c;--cut-bg:#2a1a10;--review:#facc15;--review-bg:#272111;--keep:#4ade80;--keep-bg:#112417;--ai:#a78bfa;--ai-bg:#1f1830;--accent:#ecebe6;--chip:#262624}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:20px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
.meta{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0 24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .n{font-size:26px;font-weight:650;letter-spacing:-.02em}
.card .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.card.cut .n{color:var(--cut)}.card.review .n{color:var(--review)}.card.keep .n{color:var(--keep)}.card.ai .n{color:var(--ai)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.bar button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer}
.bar button[aria-pressed=true]{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.bar input{flex:1;min-width:180px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:6px 14px;font:inherit}
.list{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.item{border-top:1px solid var(--line)}
.item:first-child{border-top:0}
.item summary{list-style:none;display:grid;grid-template-columns:90px minmax(120px,1.1fr) minmax(90px,.7fr) minmax(120px,1fr) 90px minmax(200px,2.4fr);gap:12px;align-items:center;padding:12px 16px;cursor:pointer}
.item summary::-webkit-details-marker{display:none}
.item summary:hover{background:var(--chip)}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;text-align:center}
.pill.cut{color:var(--cut);background:var(--cut-bg)}.pill.review{color:var(--review);background:var(--review-bg)}.pill.keep{color:var(--keep);background:var(--keep-bg)}
.pill.ai{color:var(--ai);background:var(--ai-bg);font-weight:500;margin-left:6px}
.name{font-weight:600}
.muted{color:var(--muted)}
.why{color:var(--ink)}
.why small{display:block;color:var(--muted)}
.detail{padding:4px 16px 16px 118px;color:var(--muted);font-size:13px}
.detail table{border-collapse:collapse;width:100%}
.detail td{padding:3px 8px 3px 0;vertical-align:top;border-bottom:1px dashed var(--line)}
.detail code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
.kv{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 10px}
h2{font-size:15px;margin:32px 0 10px}
.hosts{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.hosts td,.hosts th{text-align:left;padding:8px 12px;border-top:1px solid var(--line);font-size:13px}
.hosts th{color:var(--muted);font-weight:500;border-top:0}
footer{margin-top:40px;color:var(--muted);font-size:12px}
footer a{color:inherit}
@media (max-width:820px){.item summary{grid-template-columns:80px 1fr auto;}.item summary .c-cat,.item summary .c-where,.item summary .c-why{grid-column:1/-1}.detail{padding-left:16px}.hosts .h-hosts{display:none}}
</style>
</head>
<body>
<main>
<header><h1>stackprune</h1><span class="meta" id="meta"></span></header>
<section class="cards" id="cards"></section>
<div class="bar" role="toolbar">
  <button data-f="all" aria-pressed="true">All</button>
  <button data-f="cut" aria-pressed="false">Cut</button>
  <button data-f="review" aria-pressed="false">Review</button>
  <button data-f="keep" aria-pressed="false">Keep</button>
  <button data-f="ai" aria-pressed="false">AI-added</button>
  <input id="q" type="search" placeholder="Filter by name, category, repo…" aria-label="Filter">
</div>
<div class="list" id="list"></div>
<section id="unknown"></section>
<footer>Generated by <a href="https://github.com/YlldritQ/stackprune">stackprune</a> · <span id="gen"></span></footer>
</main>
<script id="data" type="application/json">${json}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
var S=D.summary;
function fmt(n,cur){try{return new Intl.NumberFormat('en-US',{style:'currency',currency:cur||D.currency,maximumFractionDigits:n%1===0?0:2}).format(n)}catch(e){return n+' '+(cur||D.currency)}}
function el(tag,attrs,kids){var e=document.createElement(tag);for(var k in attrs||{}){if(k==='text')e.textContent=attrs[k];else if(k==='cls')e.className=attrs[k];else e.setAttribute(k,attrs[k])}(kids||[]).forEach(function(c){if(c)e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
document.getElementById('meta').textContent=D.targets.length+(D.targets.length===1?' repo':' repos')+' · '+S.total+' integrations'+(D.usageWindow?' · runtime data '+D.usageWindow.from.slice(0,10)+' → '+D.usageWindow.to.slice(0,10):' · static scan');
document.getElementById('gen').textContent=D.generatedAt.slice(0,16).replace('T',' ');
var cards=[['cut',S.byVerdict.cut,'to cut'],['review',S.byVerdict.review,'to review'],['keep',S.byVerdict.keep,'in use']];
if(S.savingsCut||S.savingsReview)cards.push(['',fmt(S.savingsCut)+'/mo','potential savings'+(S.savingsReview?' (+'+fmt(S.savingsReview)+' in review)':'')]);
if(S.aiIntroduced)cards.push(['ai',S.aiIntroduced,'added by AI-assisted commits'+(S.aiIntroducedUnused?' · '+S.aiIntroducedUnused+' unused':'')]);
var cw=document.getElementById('cards');cards.forEach(function(c){cw.appendChild(el('div',{cls:'card '+c[0]},[el('div',{cls:'n',text:String(c[1])}),el('div',{cls:'l',text:c[2]})]))});
var KIND={manifest:'dependency',import:'import','env-declared':'env var (declared)','env-referenced':'env var (read in code)',host:'API host'};
var filter='all',q='';
function cost(i){return i.cost?(i.cost.monthly===0?'free':fmt(i.cost.monthly,i.cost.currency)+'/mo'):(i.paid?'unpriced':'free')}
function render(){
  var list=document.getElementById('list');list.innerHTML='';
  var items=D.integrations.filter(function(i){
    if(filter==='ai'&&!i.ai)return false;
    if(filter!=='all'&&filter!=='ai'&&i.verdict!==filter)return false;
    if(q){var h=(i.name+' '+i.category+' '+i.targets.join(' ')+' '+(i.owner||'')).toLowerCase();if(h.indexOf(q)<0)return false}
    return true});
  if(!items.length){list.appendChild(el('div',{cls:'detail',style:'padding:16px',text:'Nothing matches.'}));return}
  items.forEach(function(i){
    var why=el('div',{cls:'why c-why'},[i.reasons[0]||'',i.reasons.length>1?el('small',{text:i.reasons.slice(1).join(' · ')}):null]);
    var name=el('div',{},[el('span',{cls:'name',text:i.name}),i.ai?el('span',{cls:'pill ai',text:'AI · '+i.ai}):null]);
    var sum=el('summary',{},[el('span',{cls:'pill '+i.verdict,text:i.verdict}),name,el('span',{cls:'muted c-cat',text:i.category}),el('span',{cls:'c-where',text:i.targets.join(', ')}),el('span',{cls:i.cost?'':'muted',text:cost(i)}),why]);
    var kv=el('div',{cls:'kv'},[
      el('span',{text:'Status: '+i.status}),
      el('span',{text:'Files using it: '+i.codeFiles}),
      el('span',{text:'Files to touch to remove: '+i.removalFiles}),
      i.calls!=null?el('span',{text:'Runtime calls: '+i.calls.toLocaleString('en-US')}):null,
      el('span',{text:'Owner: '+(i.owner||'—')}),
      i.purpose?el('span',{text:'Purpose: '+i.purpose}):null,
      i.introducedAt?el('span',{text:'Added: '+i.introducedAt.slice(0,10)}):null,
      i.lastTouchedAt?el('span',{text:'Last touched: '+i.lastTouchedAt.slice(0,10)}):null]);
    var tb=el('table',{},i.evidence.map(function(e){return el('tr',{},[el('td',{text:e.t}),el('td',{},[el('code',{text:e.f+(e.l?':'+e.l:'')})]),el('td',{text:(KIND[e.k]||e.k)+(e.dev?' (dev/test)':'')}),el('td',{},[el('code',{text:e.d})])])}));
    list.appendChild(el('details',{cls:'item'},[sum,el('div',{cls:'detail'},[kv,tb])]));
  });
}
document.querySelectorAll('.bar button').forEach(function(b){b.addEventListener('click',function(){filter=b.getAttribute('data-f');document.querySelectorAll('.bar button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});render()})});
document.getElementById('q').addEventListener('input',function(e){q=e.target.value.trim().toLowerCase();render()});
render();
if(D.unknownHosts.length){
  var u=document.getElementById('unknown');
  u.appendChild(el('h2',{text:'Unknown external domains'}));
  u.appendChild(el('p',{cls:'muted',text:'Referenced in code but not in the vendor catalog. Add the real integrations under vendors: in stackprune.yml.'}));
  var t=el('table',{cls:'hosts'},[el('tr',{},[el('th',{text:'Domain'}),el('th',{text:'Files'}),el('th',{text:'Where'}),el('th',{cls:'h-hosts',text:'Hosts'})])]);
  D.unknownHosts.slice(0,40).forEach(function(h){t.appendChild(el('tr',{},[el('td',{text:h.domain}),el('td',{text:String(h.files)+(h.calls?' · '+h.calls+' calls':'')}),el('td',{text:h.targets.join(', ')}),el('td',{cls:'h-hosts muted',text:h.hosts.slice(0,4).join(', ')})]))});
  u.appendChild(t);
}
})();
</script>
</body>
</html>
`;
}

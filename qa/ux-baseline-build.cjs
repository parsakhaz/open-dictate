const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'), base=path.join(root,'tmp/verify/ux-restore/baseline');
(async()=>{if(!fs.existsSync(path.join(base,'src/renderer/pill.ts'))){for(const f of execFileSync('git',['ls-tree','-r','--name-only','73c9398','src/renderer','src/core'],{cwd:root,encoding:'utf8'}).trim().split('\n')){const target=path.join(base,f);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,execFileSync('git',['show','73c9398:'+f],{cwd:root}));}}for(const [name,src] of [['baseline',path.join(base,'src/renderer')],['restored',path.join(root,'src/renderer')]]){
const out=path.join(root,'tmp/verify/ux-restore/visual',name);fs.mkdirSync(out,{recursive:true});
await build({entryPoints:{pill:path.join(src,'pill.ts'),picker:path.join(src,'picker.ts'),sheet:path.join(src,'sheet/index.ts')},outdir:out,bundle:true,platform:'browser',format:'esm',target:'chrome140'});
for(const f of ['pill.css','theme.css','picker.css'])fs.copyFileSync(path.join(src,f),path.join(out,f));
const files=fs.readdirSync(path.join(src,'cards')).filter(f=>f.endsWith('.css')).sort((a,b)=>a==='base.css'?-1:b==='base.css'?1:a.localeCompare(b));
fs.writeFileSync(path.join(out,'cards.css'),files.map(f=>fs.readFileSync(path.join(src,'cards',f),'utf8')).join('\n'));
fs.writeFileSync(path.join(out,'pill.html'),fs.readFileSync(path.join(src,'pill.html'),'utf8').replace('<script type="module"','<script src="fixture.js"></script><script type="module"'));
for(const page of ['picker','sheet'])fs.writeFileSync(path.join(out,page+'.html'),fs.readFileSync(path.join(src,page+'.html'),'utf8').replace('<script type="module"','<script src="fixture.js"></script><script type="module"'));
const sheets=fs.readdirSync(path.join(src,'sheet')).filter(f=>f.endsWith('.css')).sort((a,b)=>a==='base.css'?-1:b==='base.css'?1:a.localeCompare(b));fs.writeFileSync(path.join(out,'sheet.css'),sheets.map(f=>fs.readFileSync(path.join(src,'sheet',f),'utf8')).join('\n'));
fs.writeFileSync(path.join(out,'fixture.js'),`const listeners={}; Date.now=()=>1800000000000; window.__emit=(ch,...args)=>(listeners[ch]||[]).forEach(f=>f(...args)); window.dictate={on:(ch,f)=>{(listeners[ch]??=[]).push(f);return ()=>{}},send:()=>{},invoke:async ch=>ch==='dictate:inbox:config'?{lengths:[3,5,10],key:null}:null};`);
}})().catch(e=>{console.error(e);process.exitCode=1});

import {readdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const dir=process.argv[2],entries=await readdir(dir),catalog={};
const put=(key,file)=>execFileSync('npx',['wrangler','r2','object','put','esphub-production/releases/'+key,'--file',file,'--remote'],{stdio:'inherit'});
for(const name of entries.filter(x=>x.endsWith('.json'))){
 const manifest=JSON.parse(await readFile(path.join(dir,name)));
 if(!['paper-color','stopwatch'].includes(manifest.board))throw Error('Unexpected board');
 for(const type of ['usb','ota']){
   const asset=manifest[type];if(path.basename(asset.file)!==asset.file)throw Error('Unexpected release path');
   const p=path.join(dir,asset.file);
   if(createHash('sha256').update(await readFile(p)).digest('hex')!==asset.sha256)throw Error('Release checksum mismatch');
   put(asset.file,p);
 }
 catalog[manifest.board]=manifest;
}
if(Object.keys(catalog).length!==2||catalog.stopwatch.version!==catalog['paper-color'].version)throw Error('Incomplete firmware release');
const file=path.join(dir,'latest.json');await writeFile(file,JSON.stringify(catalog));put('latest.json',file);

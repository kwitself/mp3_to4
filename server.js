'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {spawn} = require('child_process');
const archiver = require('archiver');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const app = express();
app.disable('x-powered-by');
const ROOT = path.resolve(process.env.JOBS_DIR || path.join(os.tmpdir(),'framesound-jobs'));
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 100)*1048576;
const MAX_DURATION = Number(process.env.MAX_DURATION_SECONDS || 3600);
const MAX_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const TTL = 2*60*60*1000;
const active = new Set();
fs.mkdirSync(ROOT,{recursive:true});
app.use(express.static(path.join(__dirname,'public'),{index:'index.html',extensions:false}));

function execute(bin,args,timeout=1200000){
  return new Promise((resolve,reject)=>{
    let settled=false, err='';
    const child=spawn(bin,args,{windowsHide:true,stdio:['ignore','ignore','pipe']});
    const done=(e)=>{if(settled)return;settled=true;clearTimeout(timer); e?reject(e):resolve();};
    child.stderr.on('data',b=>{err=(err+b.toString()).slice(-1600);});
    child.on('error',done);
    child.on('close',code=>done(code===0?null:new Error('FFmpeg hatası: '+err.slice(-500))));
    const timer=setTimeout(()=>{child.kill('SIGKILL');done(new Error('İşlem zaman aşımına uğradı.'));},timeout);
  });
}
function probe(file){
 return new Promise((resolve,reject)=>{
   const p=spawn(ffprobe,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{windowsHide:true});
   let text='',err=''; const timer=setTimeout(()=>p.kill(),20000);
   p.stdout.on('data',b=>text+=b);p.stderr.on('data',b=>err+=b);
   p.on('error',e=>{clearTimeout(timer);reject(e);});
   p.on('close',c=>{clearTimeout(timer);const n=Number(text.trim());c===0&&Number.isFinite(n)&&n>0?resolve(n):reject(new Error('Ses/video süresi okunamadı. '+err.slice(-100)));});
 });
}
const safe=(n,def,min,max)=>{const x=Number(n);return Number.isFinite(x)?Math.max(min,Math.min(max,x)):def;};
function settings(body){
 const layout=['square','story','landscape','custom'].includes(body.layout)?body.layout:'story';
 const preset={square:[1080,1080],story:[1080,1920],landscape:[1920,1080]};
 const [width,height]=preset[layout]||[Number(body.width),Number(body.height)];
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<240||height<240||width>3840||height>3840||width%2||height%2||width*height>8294400)throw Error('Çözünürlük 240–3840 aralığında çift değerlerden oluşmalı (maksimum 8,3 MP).');
 const quality=Math.round(safe(body.quality,70,1,100));
 const reduction=Math.round(safe(body.reduction,0,0,85));
 const pixelFactor=Math.sqrt(width*height/(1080*1920));
 const videoKbps=Math.max(18,Math.round((90+quality*5.1)*pixelFactor*(1-reduction/100)));
 const audioKbps=Math.max(48,Math.round((64+quality*1.28)*(1-reduction/130)));
 return {layout,width,height,quality,reduction,videoKbps,audioKbps,split:body.split==='true'};
}
function uploadMiddleware(req,res,next){
 if(active.size>=MAX_JOBS)return res.status(429).json({error:'Sunucu meşgul. Biraz sonra tekrar deneyin.'});
 req.jobId=crypto.randomBytes(16).toString('hex');
 req.jobDir=path.join(ROOT,req.jobId);
 fs.mkdirSync(req.jobDir,{recursive:true});
 active.add(req.jobId);
 next();
}
const upload=multer({
 storage:multer.diskStorage({
  destination(req,file,cb){cb(null,req.jobDir);},
  filename(req,file,cb){
   const ext=path.extname(file.originalname).toLowerCase();
   cb(null,file.fieldname+(ext||'.bin'));
  }
 }),
 limits:{fileSize:MAX_UPLOAD,files:2,fields:8},
 fileFilter(req,file,cb){
  const ext=path.extname(file.originalname).toLowerCase();
  const valid=file.fieldname==='image'?['.jpg','.jpeg','.png','.webp']:file.fieldname==='audio'?['.mp3','.wav','.m4a','.aac','.ogg','.flac']:[];
  cb(valid.includes(ext)?null:new Error('Desteklenmeyen dosya türü.'),valid.includes(ext));
 }
}).fields([{name:'image',maxCount:1},{name:'audio',maxCount:1}]);
const mb=bytes=>Math.round(bytes*100)/100;
const fileInfo=async(name,file,duration,id)=>{
 const st=await fsp.stat(file);
 return {name,filename:path.basename(file),bytes:st.size,duration:mb(duration),url:'/api/download/'+id+'/'+path.basename(file)};
};
app.post('/api/convert',uploadMiddleware,(req,res)=>{
 upload(req,res,async(uploadError)=>{
  try{
   if(uploadError)throw Error(uploadError.code==='LIMIT_FILE_SIZE'?'Dosya yükleme sınırını aştı.':uploadError.message);
   const image=req.files?.image?.[0]?.path, audio=req.files?.audio?.[0]?.path;
   if(!image||!audio)throw Error('Fotoğraf ve ses dosyasını birlikte seçmelisiniz.');
   const opt=settings(req.body);
   const duration=await probe(audio);
   if(duration>MAX_DURATION)throw Error('Ses süresi sunucu sınırını aşıyor.');
   const output=path.join(req.jobDir,'video.mp4');
   const vf='scale='+opt.width+':'+opt.height+':force_original_aspect_ratio=decrease:flags=lanczos,pad='+opt.width+':'+opt.height+':(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p';
   // One frame per second is sufficient for a static-image video and dramatically reduces CPU use.
   await execute(ffmpeg,['-hide_banner','-loglevel','error','-y','-loop','1','-framerate','1','-i',image,'-i',audio,'-map','0:v:0','-map','1:a:0','-vf',vf,'-c:v','libx264','-preset','veryfast','-tune','stillimage','-r','1','-g','1','-b:v',opt.videoKbps+'k','-maxrate',opt.videoKbps+'k','-bufsize',(opt.videoKbps*2)+'k','-c:a','aac','-b:a',opt.audioKbps+'k','-ar','44100','-ac','2','-t',String(duration),'-movflags','+faststart',output]);
   const files=[await fileInfo('Tam video',output,duration,req.jobId)];
   if(opt.split){
     const dir=path.join(req.jobDir,'parts');await fsp.mkdir(dir);
     for(let i=0,start=0;start<duration-.005;i++,start=i*60){
       const length=Math.min(60,duration-start);
       const target=path.join(dir,'story_'+String(i+1).padStart(3,'0')+'.mp4');
       await execute(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(start),'-i',output,'-t',String(length),'-map','0:v:0','-map','0:a:0','-c:v','libx264','-preset','ultrafast','-r','1','-c:a','aac','-b:a',opt.audioKbps+'k','-movflags','+faststart',target]);
       files.push(await fileInfo('Story '+(i+1),target,await probe(target),req.jobId));
     }
   }
   const estimatedBytes=Math.round(duration*(opt.videoKbps+opt.audioKbps)*1000/8*1.025);
   res.json({id:req.jobId,estimatedBytes,files,zipUrl:opt.split?'/api/zip/'+req.jobId:null,settings:opt});
  }catch(e){
   res.status(400).json({error:e.message});
  }finally{active.delete(req.jobId);}
 });
});
const validId=x=>/^[0-9a-f]{32}$/.test(x||'');
app.get('/api/download/:id/:filename',async(req,res)=>{
 const {id,filename}=req.params;
 if(!validId(id)||!(/^(video\.mp4|story_\d{3}\.mp4)$/.test(filename)))return res.sendStatus(404);
 const target=path.join(ROOT,id,filename==='video.mp4'?filename:path.join('parts',filename));
 try{await fsp.access(target);res.download(target,filename);}catch{res.status(404).send('Dosya bulunamadı veya süresi doldu.');}
});
app.get('/api/zip/:id',async(req,res)=>{
 if(!validId(req.params.id))return res.sendStatus(404);
 const dir=path.join(ROOT,req.params.id,'parts');
 let files;try{files=(await fsp.readdir(dir)).filter(f=>/^story_\d{3}\.mp4$/.test(f)).sort();}catch{return res.sendStatus(404);}
 if(!files.length)return res.sendStatus(404);
 res.attachment('story-parcalari.zip');
 const zip=archiver('zip',{zlib:{level:0}});
 zip.on('error',()=>{if(!res.headersSent)res.sendStatus(500);else res.destroy();});
 zip.pipe(res);
 for(const file of files)zip.file(path.join(dir,file),{name:file});
 await zip.finalize();
});
async function cleanup(){
 try{
  for(const item of await fsp.readdir(ROOT,{withFileTypes:true})){
   if(!item.isDirectory()||active.has(item.name))continue;
   const dir=path.join(ROOT,item.name),stat=await fsp.stat(dir);
   if(Date.now()-stat.mtimeMs>TTL)await fsp.rm(dir,{recursive:true,force:true});
  }
 }catch(e){console.warn('Cleanup:',e.message);}
}
setInterval(cleanup,15*60*1000).unref();cleanup();
app.listen(PORT,()=>console.log('FrameSound: http://localhost:'+PORT));

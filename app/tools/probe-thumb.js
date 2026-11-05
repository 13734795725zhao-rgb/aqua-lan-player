const fs=require('fs'),path=require('path'),os=require('os');
const koffi=require('koffi');
const win32=require('../src/main/win32');
const {MpvThumb}=require('../src/main/mpv');
const user32=koffi.load('user32.dll');
const CW=user32.func('uintptr_t CreateWindowExW(uint dwExStyle, const char16_t *lpClassName, const char16_t *lpWindowName, uint dwStyle, int X, int Y, int nWidth, int nHeight, uintptr_t hWndParent, uintptr_t hMenu, uintptr_t hInstance, uintptr_t lpParam)');
const parent=CW(0,'STATIC','probe',0x80000000,0,0,320,180,0n,0n,0n,0n)||0n;
const c=win32.createContainer(parent,0,0,320,180);
console.log('parent=0x'+parent.toString(16),'container=0x'+c.toString(16));
const t=new MpvThumb({binDir:path.resolve('..','bin'),containerHwnd:c});
const v=process.argv[2];
t.load(v);
console.log('已投递 loadfile:', path.basename(v));
setTimeout(()=>{
  const out=path.join(os.tmpdir(),'pt.png');
  const rc=t.command('screenshot-to-file',out,'video');
  console.log('screenshot-to-file rc=',rc);
  setTimeout(()=>{
    if(!fs.existsSync(out)){ console.log('!! 没有产出文件'); }
    else{
      const b=fs.readFileSync(out);
      const png=b.length>8&&b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47;
      const tail=b.slice(-8,-4).toString('latin1');
      console.log('size=',b.length,'png头=',png,'结束标记=',tail);
      console.log((png&&tail==='IEND')?'OK 缩略图链路正常':'!! 缩略图不可用');
    }
    process.exit(0);
  },1000);
},2000);
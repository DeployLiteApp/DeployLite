function fail():never{throw new Error("Database restore volume archive is unavailable.");}
/** Accept only the bounded regular-file/directory USTAR subset emitted by the existing native volume writer. */
export function validateManagedDatabaseRestoreTar(raw:Uint8Array,maxBytes:number,maxEntries=10000):Readonly<{bytes:number;entries:number}>{
 try{
  if(!(raw instanceof Uint8Array)||!Number.isSafeInteger(maxBytes)||maxBytes<1024||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>10000||raw.length<1024||raw.length>maxBytes||raw.length%512!==0)fail();
  const bytes=Buffer.from(raw),seen=new Map<string,"file"|"directory">();let offset=0;
  const text=(header:Buffer,start:number,size:number)=>{const field=header.subarray(start,start+size),nul=field.indexOf(0),end=nul<0?field.length:nul;if(nul>=0&&field.subarray(nul).some(value=>value!==0))fail();return new TextDecoder("utf-8",{fatal:true}).decode(field.subarray(0,end));};
  const octal=(header:Buffer,start:number,size:number)=>{const value=header.subarray(start,start+size).toString("ascii").replace(/[\x00 ]+$/g,"");if(!/^[0-7]+$/.test(value))fail();const number=Number.parseInt(value,8);if(!Number.isSafeInteger(number)||number<0)fail();return number;};
  while(offset<bytes.length){
   const header=bytes.subarray(offset,offset+512);
   if(header.every(value=>value===0)){if(bytes.length-offset!==1024||bytes.subarray(offset).some(value=>value!==0))fail();return Object.freeze({bytes:bytes.length,entries:seen.size});}
   if(seen.size>=maxEntries||header.subarray(257,263).toString("binary")!=="ustar\0"||header.subarray(263,265).toString("ascii")!=="00")fail();
   const checksum=octal(header,148,8);let sum=0;for(let index=0;index<512;index++)sum+=(index>=148&&index<156)?32:header[index]!;if(sum!==checksum)fail();
   const kind=header[156]===48?"file":header[156]===53?"directory":fail();
   const prefix=text(header,345,155),name=text(header,0,100),path=(prefix?prefix+"/":"")+name;
   if(!path||path.startsWith("/")||path.includes("\\")||path.includes(":")||/[\x00-\x1f\x7f]/.test(path)||text(header,157,100)||text(header,265,32)||text(header,297,32))fail();
   const normalized=kind==="directory"?path.replace(/\/$/,""):path;
   if((kind==="directory"&&!path.endsWith("/"))||normalized.split("/").some(part=>!part||part==="."||part==="..")||seen.has(normalized))fail();
   const size=octal(header,124,12),mode=octal(header,100,8);octal(header,136,12);
   if(mode>0o777||octal(header,108,8)!==0||octal(header,116,8)!==0||octal(header,329,8)!==0||octal(header,337,8)!==0||(kind==="directory"&&size!==0))fail();
   for(const [other,otherKind] of seen){if((otherKind==="file"&&normalized.startsWith(other+"/"))||(kind==="file"&&other.startsWith(normalized+"/")))fail();}
   const end=offset+512+size,next=offset+512+Math.ceil(size/512)*512;
   if(!Number.isSafeInteger(next)||next>bytes.length-1024||bytes.subarray(end,next).some(value=>value!==0))fail();
   seen.set(normalized,kind);offset=next;
  }
  return fail();
 }catch{return fail();}
}

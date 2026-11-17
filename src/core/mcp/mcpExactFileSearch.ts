/**
 * Deterministic, bounded search restricted to an explicit list of approved
 * regular files. Never launches rg/shell or recursively enumerates directories.
 */
import fs from "node:fs";
import path from "node:path";
import {
  absoluteCanonical, certifiedExplicitGrepSearchArgs,
  fileRulesRegistered, isPathAllowedByPermanentRegistry,
} from "../tools/registeredFileToolGate.js";

const MAX_FILE_BYTES=1024*1024;
const MAX_TOTAL_BYTES=8*1024*1024;
type SearchResult={file:string;line:number;text:string};

export function searchExplicitAuthorizedFiles(
  args:Record<string,unknown>, workspace:string,
):{matches:SearchResult[];totalMatches:number;offset:number;hasMore:boolean;filesSearched:number;scannedBytes:number}{
  if(!certifiedExplicitGrepSearchArgs(args))throw new Error("INVALID_EXPLICIT_FILE_SEARCH");
  if(!path.isAbsolute(workspace))throw new Error("A local absolute workspace is required.");
  const root=fs.realpathSync.native(workspace);
  const query=String(args.query);
  const caseSensitive=args.caseSensitive===true;
  const needle=caseSensitive?query:query.toLowerCase();
  const offset=Number(args.offset??0);
  const limit=Number(args.limit??100);
  const matches:SearchResult[]=[];
  let totalMatches=0,filesSearched=0,scannedBytes=0;
  for(const raw of args.filePaths as string[]){
    const file=absoluteCanonical(raw,root);
    if(!file)throw new Error("Non-canonical explicit search file.");
    const relative=path.relative(root,file);
    if(relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))
      throw new Error("Explicit file is outside the workspace.");
    if(fileRulesRegistered()&&!isPathAllowedByPermanentRegistry(file,"read"))
      throw new Error("Permanent file policy denies explicit search input.");
    const flags=fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW||0);
    const fd=fs.openSync(file,flags);
    try {
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.size>MAX_FILE_BYTES||
         scannedBytes+stat.size>MAX_TOTAL_BYTES)
        throw new Error("EXPLICIT_FILE_SEARCH_BUDGET_EXCEEDED");
      // Re-check the path after opening the handle. Windows lacks O_NOFOLLOW
      // on some runtimes, so a concurrent symlink swap must not silently
      // redirect this explicit-file read to a different canonical target.
      const realOpen=fs.realpathSync.native(file).replace(/^\\\\\?\\/,"");
      const canonicalFile=file.replace(/^\\\\\?\\/,"");
      if(process.platform==="win32"
        ? realOpen.toLowerCase()!==canonicalFile.toLowerCase()
        : realOpen!==canonicalFile)
        throw new Error("EXPLICIT_FILE_SEARCH_SOURCE_CHANGED");
      // Read exactly the attested size, never an unbounded readFileSync(fd)
      // if another process appends to the file after fstat.
      const bytes=Buffer.alloc(stat.size);
      let received=0;
      while(received<bytes.length){
        const count=fs.readSync(fd,bytes,received,bytes.length-received,received);
        if(count<=0)throw new Error("EXPLICIT_FILE_SEARCH_SOURCE_CHANGED");
        received+=count;
      }
      const after=fs.fstatSync(fd);
      if(after.size!==stat.size||after.dev!==stat.dev||after.ino!==stat.ino||
         after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)
        throw new Error("EXPLICIT_FILE_SEARCH_SOURCE_CHANGED");
      const text=bytes.toString("utf8");
      scannedBytes+=received;
      filesSearched++;
      for(const [index,line] of text.split(/\r?\n/).entries()){
        if((caseSensitive?line:line.toLowerCase()).includes(needle)){
          if(totalMatches>=offset&&matches.length<limit)
            matches.push({file:raw,line:index+1,text:line.slice(0,500)});
          totalMatches++;
        }
      }
    }finally{fs.closeSync(fd);}
  }
  return {matches,totalMatches,offset,hasMore:offset+matches.length<totalMatches,
    filesSearched,scannedBytes};
}

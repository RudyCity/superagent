import {describe, expect, it} from "vitest";
import {
 EMPTY_ACCESS_POLICY, parsePersistentAccessPolicy, evaluatePersistentAccess,
 type PersistentAccessPolicy,
} from "../../src/core/desktopUi/persistentAccessPolicy.js";
const app = {platform:"win32" as const,executablePath:"C:\\Apps\\Antigravity\\antigravity.exe",sha256:"a".repeat(64)};
const other = {...app,sha256:"b".repeat(64)};
const base = {version:2 as const,defaultEffect:"deny" as const};
const desktop = {id:"antigravity-chat",kind:"desktop" as const,effect:"allow" as const,app,
  operations:["input" as const],scope:{windowTitle:"Antigravity",elementRole:"edit"}};
const folder = {id:"project-read",kind:"file" as const,effect:"allow" as const,app,
  operations:["read" as const],scope:{path:"G:\\project\\tryout-online",recursive:true}};
const denied = {id:"secrets",kind:"file" as const,effect:"deny" as const,app,
  operations:["read" as const],scope:{path:"G:\\project\\tryout-online\\.env",recursive:false}};
describe("persistent, host-owned app/file registration",()=>{
 it("defaults to deny and never requires an expiry for registered rules",()=>{
   expect(evaluatePersistentAccess(EMPTY_ACCESS_POLICY,{kind:"desktop",app,operation:"input",windowTitle:"Antigravity"}).effect).toBe("deny");
   const p = {...base,rules:[desktop,folder]};
   expect(parsePersistentAccessPolicy(p)).toEqual(p);
   expect(JSON.stringify(p)).not.toContain("expiresAt");
 });
 it("allows only verified exact executable identity, window, UI role and operation",()=>{
   const p = {...base,rules:[desktop]};
   const request={kind:"desktop" as const,app,operation:"input" as const,
     windowTitle:"Antigravity",elementRole:"edit"};
   expect(evaluatePersistentAccess(p,request).effect).toBe("allow");
   expect(evaluatePersistentAccess(p,{...request,app:other}).effect).toBe("deny");
   expect(evaluatePersistentAccess(p,{...request,windowTitle:"Another app"}).effect).toBe("deny");
   expect(evaluatePersistentAccess(p,{...request,elementRole:"button"}).effect).toBe("deny");
   expect(evaluatePersistentAccess(p,{...request,operation:"view"}).effect).toBe("deny");
 });
 it("blocks specific files inside allowed directories, including Windows case variants",()=>{
   const p = {...base,rules:[folder,denied]};
   const file=(path:string,operation:"read"|"write"="read")=>
     evaluatePersistentAccess(p,{kind:"file",app,operation,path});
   expect(file("G:\\project\\tryout-online\\src\\main.ts").effect).toBe("allow");
   expect(file("g:\\PROJECT\\tryout-online\\.env").effect).toBe("deny");
   expect(file("G:\\project\\tryout-online\\.env").matchedRuleId).toBe("secrets");
   expect(file("G:\\project\\tryout-online-other\\README.md").effect).toBe("deny");
   expect(file("G:\\project\\tryout-online\\src\\..\\secret.txt").effect).toBe("deny");
   expect(file("G:\\project\\tryout-online\\src\\main.ts","write").effect).toBe("deny");
 });
 it("rejects wildcard identities, unsupported default allow, duplicate rules and unknown fields",()=>{
   const p:PersistentAccessPolicy={...base,rules:[desktop]};
   expect(parsePersistentAccessPolicy({...p,defaultEffect:"allow"})).toBeNull();
   expect(parsePersistentAccessPolicy({...p,unknown:true})).toBeNull();
   expect(parsePersistentAccessPolicy({...p,rules:[desktop,desktop]})).toBeNull();
   expect(parsePersistentAccessPolicy({...p,rules:[{...desktop,app:{...app,sha256:"*"}}]})).toBeNull();
   expect(parsePersistentAccessPolicy({...p,rules:[{...desktop,scope:{...desktop.scope,elementLabel:"chat",foo:"x"}}]})).toBeNull();
   expect(parsePersistentAccessPolicy({...p,rules:[{...folder,scope:{path:"\\\\server\\share",recursive:true}}]})).toBeNull();
 });
 it("explicit deny takes precedence over registration order",()=>{
   const p = {...base,rules:[folder,denied]};
   expect(evaluatePersistentAccess(p,{kind:"file",app,operation:"read",path:denied.scope.path}).effect).toBe("deny");
   expect(evaluatePersistentAccess({...p,rules:[denied,folder]},
     {kind:"file",app,operation:"read",path:denied.scope.path}).effect).toBe("deny");
 });
});

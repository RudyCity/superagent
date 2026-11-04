import {describe,it,expect} from "vitest";
import {validateManageServicesArgs,manageServices,inspectServices,
  MANAGED_SERVICE_NAMES} from "../src/core/runtime/serviceManager.js";
import {manageServicesTool} from "../src/core/tools/serviceManagerTools.js";
import {masterToolset,superagentToolset,chromeExtensionToolset} from "../src/core/tools/toolsets.js";

describe("unified SuperAgent service manager",()=>{
  it("validates all operations and blocks arbitrary process commands",()=>{
    expect(()=>validateManageServicesArgs({action:"terminate",service:"all"})).toThrow("UNKNOWN_ACTION");
    expect(()=>validateManageServicesArgs({action:"status",service:"foreign_service"})).toThrow("UNKNOWN_TARGET");
    expect(()=>validateManageServicesArgs({action:"status",port:0})).toThrow("INVALID_PORT");
    expect(()=>validateManageServicesArgs({action:"status",command:"taskkill /F"})).toThrow("UNEXPECTED_ARGUMENT");
    expect(()=>validateManageServicesArgs({action:"restart",service:"all",confirm:true})).toThrow("SINGLE_TARGET");
  });
  it("reports all registered service kinds read-only and without credentials",async()=>{
    const entries=await inspectServices("all");
    for(const name of MANAGED_SERVICE_NAMES)
      expect(entries.find(e=>e.service===name)).toBeDefined();
    const inventory=await manageServices({action:"inventory"});
    expect(inventory).toHaveProperty("readOnly",true);
    expect(JSON.stringify(inventory)).not.toContain("authToken");
    expect(JSON.stringify(inventory)).not.toContain("ipcToken");
  },25000);
  it("does not permit kill, start, stop or reload on unowned services",async()=>{
    await expect(manageServices({action:"restart",service:"vision",port:19461}))
      .rejects.toThrow("CONFIRM_REQUIRED");
    await expect(manageServices({action:"stop",service:"tray",confirm:true}))
      .rejects.toThrow("UNSUPPORTED_MUTATION");
    const plan:any=await manageServices({
      action:"plan",service:"transport",targetAction:"restart",port:19561});
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toContain("UNSUPPORTED_MUTATION");
  });
  it("fails closed for unregistered or legacy MCP reload",async()=>{
    await expect(manageServices({
      action:"plan",service:"mcp",targetAction:"reload",port:19562,
    })).rejects.toThrow("MCP_LEGACY_OR_UNVERIFIED");
    await expect(manageServices({
      action:"reload",service:"mcp",port:19562,confirm:true,
    })).rejects.toThrow("MCP_PLAN_REQUIRED");
  });
  it("does not restart an unsupervised API Core",async()=>{
    await expect(manageServices({
      action:"plan",service:"core",port:19563,targetAction:"restart",
    })).rejects.toThrow(/No supervised core|SERVICE_CORE_KERNEL_OWNER_UNVERIFIED/);
    await expect(manageServices({
      action:"restart",service:"core",port:19563,confirm:true,
    })).rejects.toThrow("CORE_PLAN_REQUIRED");
  });
  it("registers the same single management tool for all agent tiers",()=>{
    for(const tools of [masterToolset,superagentToolset,chromeExtensionToolset]){
      expect(tools.find(tool=>tool.name==="manage_services")).toBeDefined();
    }
    expect(manageServicesTool.name).toBe("manage_services");
  });
});

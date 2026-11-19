import {describe,it,expect} from "vitest";
import {manageServices} from "../src/core/runtime/serviceManager.js";

describe("service health categories are non-mutating and never conflate optional absences",()=>{
  it("partitions the 13-service catalog without treating all inactive services as failed",async()=>{
    const response=await manageServices({action:"health",service:"all"}) as {
      readOnly:boolean;
      checks:Array<{service:string;category:string;state:string;ready:boolean;alive:boolean}>;
      summary:Record<string,number>;
    };
    expect(response.readOnly).toBe(true);
    expect(response.checks).toHaveLength(13);
    const categories=[
      "ready","degraded","unverified","not_configured","inactive","blocked","failed",
    ];
    for(const item of response.checks) {
      expect(categories).toContain(item.category);
      if(item.category==="ready")expect(item.ready).toBe(true);
      if(item.category==="not_configured")expect(item.alive).toBe(false);
      if(item.category==="unverified")expect(item.state).toBe("unverified");
    }
    const s=response.summary;
    expect(s.total).toBe(13);
    expect(s.ready+s.degraded+s.unverified+s.notConfigured+
      s.inactive+s.blocked+s.failed).toBe(s.total);
    expect(s.unavailable).toBe(s.failed+s.unverified);
  });
});

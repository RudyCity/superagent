import { describe, expect, test } from "vitest";
import {
  checkNativeDependencies, nativeDependencyInstallPlan,
  dependencyInstallInstructions, installNativeDependencies,
} from "../src/core/runtime/nativeDependencies.js";

function probeFactory(initial: {ffmpeg?: boolean;ffprobe?: boolean}) {
  const values={ ffmpeg: initial.ffmpeg??false, ffprobe:initial.ffprobe??false };
  const calls:string[]=[];
  return {
    values,calls,
    probe: (cmd:string,args:string[]) => {
      calls.push(cmd+" "+args.join(" "));
      return {
        status: cmd==="ffmpeg"||cmd==="ffprobe" ? (values[cmd]?0:1) : 1,
        stdout: cmd==="ffmpeg"&&values.ffmpeg ? "ffmpeg version 8.1\n" : "",
      };
    },
  };
}

describe("native optional dependency bootstrap",()=>{
  test("probes real executables and shows missing tools independently",()=>{
    const deps=probeFactory({ffmpeg:true,ffprobe:false});
    const item=checkNativeDependencies(deps.probe)[0];
    expect(item).toMatchObject({id:"ffmpeg",installed:false,missing:["ffprobe"]});
    expect(deps.calls).toEqual(["ffmpeg -version","ffprobe -version"]);
    deps.values.ffprobe=true;
    expect(checkNativeDependencies(deps.probe)[0]).toMatchObject({
      installed:true,version:"ffmpeg version 8.1",missing:[],
    });
  });

  test("installs through exact, reviewed package-manager arguments, never a shell or curl pipe",()=>{
    expect(nativeDependencyInstallPlan("win32",new Set(["winget"]))).toMatchObject({
      executable:"winget",args:["install","--id","Gyan.FFmpeg","--exact","--source","winget",
        "--scope","user","--accept-package-agreements","--accept-source-agreements"],
    });
    expect(nativeDependencyInstallPlan("darwin",new Set(["brew"]))).toMatchObject({
      executable:"brew",args:["install","ffmpeg"],
    });
    expect(nativeDependencyInstallPlan("linux",new Set(["apt-get"]),true)).toMatchObject({
      executable:"apt-get",args:["install","-y","ffmpeg"],
    });
    expect(nativeDependencyInstallPlan("linux",new Set(["apt-get"]),false)).toBeNull();
    expect(nativeDependencyInstallPlan("linux",new Set(["dnf"]),true)?.executable).toBe("dnf");
    expect(nativeDependencyInstallPlan("freebsd",new Set(["apt-get"]),true)).toBeNull();
    expect(dependencyInstallInstructions("linux")).toContain("ffmpeg");
  });

  test("never executes an install without explicit approval",async()=>{
    const deps=probeFactory({});
    let launched=false;
    const result=await installNativeDependencies({
      approved:false,probe:deps.probe,
      plan:{executable:"winget",args:["install","--id","Gyan.FFmpeg"],label:"FFmpeg"},
      execute:async()=>{launched=true;return 0;},
    });
    expect(result.status).toBe("declined");
    expect(launched).toBe(false);
  });

  test("approved install verifies ffmpeg AND ffprobe after completion",async()=>{
    const deps=probeFactory({});
    let installed=0;
    const plan={executable:"winget",args:["install","--id","Gyan.FFmpeg"],label:"FFmpeg"};
    const success=await installNativeDependencies({
      approved:true,probe:deps.probe,plan,
      execute:async p=>{
        expect(p).toEqual(plan);
        installed++;
        deps.values.ffmpeg=true;
        deps.values.ffprobe=true;
        return 0;
      },
    });
    expect(success.status).toBe("installed");
    expect(installed).toBe(1);
    const repeated=await installNativeDependencies({
      approved:true,probe:deps.probe,plan,execute:async()=>{installed++;return 0;},
    });
    expect(repeated.status).toBe("already-installed");
    expect(installed).toBe(1);
  });

  test("fails closed on package manager errors, missing manager, or stale PATH",async()=>{
    const deps=probeFactory({});
    const plan={executable:"winget",args:["install","--id","Gyan.FFmpeg"],label:"FFmpeg"};
    expect((await installNativeDependencies({
      approved:true,probe:deps.probe,plan,execute:async()=>1,
    })).status).toBe("failed");
    expect((await installNativeDependencies({
      approved:true,probe:deps.probe,plan,execute:async()=>0,
    })).message).toContain("Open a new terminal");
    expect((await installNativeDependencies({
      approved:true,os:"win32",probe:deps.probe,plan:null,
    })).status).toBe("unsupported");
  });
});

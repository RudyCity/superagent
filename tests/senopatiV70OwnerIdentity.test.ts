import {describe,it,expect} from "vitest";
import {isSenopatiSharedOwnerHealthy} from "../src/core/senopatiLifecycle.js";
import type {SenopatiWatchdogHealth} from "../src/core/senopatiWatchdogStatus.js";
import type {SharedHealth} from "../src/core/senopatiSharedClient.js";

const watch:SenopatiWatchdogHealth={
  pid:100,alive:true,heartbeatFresh:true,modelPid:200,healthy:true,
  configuredPrecision:"int8_embedding",updatedAt:Date.now(),
};
const model:SharedHealth={
  pid:200,precision:"int8_embedding",tokenizerEngine:"rust-native",
  rssMiB:580,active:0,accepted:0,rejected:0,
};
describe("shared inference autostart owner-identity checks",()=>{
  it("does not autostart a duplicate model with matching healthy owners",()=>{
    expect(isSenopatiSharedOwnerHealthy(watch,model,"int8_embedding")).toBe(true);
  });
  it.each([
    {watch:null,model},
    {watch:{...watch,alive:false},model},
    {watch:{...watch,healthy:false},model},
    {watch:{...watch,heartbeatFresh:false},model},
    {watch:{...watch,modelPid:null},model},
    {watch:{...watch,configuredPrecision:null},model},
    {watch:{...watch,configuredPrecision:"fp32" as const},model},
    {watch,model:null},
    {watch,model:{...model,pid:201}},
    {watch,model:{...model,precision:"fp32" as const}},
  ])("fails closed on stale, mismatched or missing owner identity",({watch,model})=>{
    expect(isSenopatiSharedOwnerHealthy(watch,model,"int8_embedding")).toBe(false);
  });
  it("refuses handoff when precision policy changes before heartbeat updates",()=>{
    expect(isSenopatiSharedOwnerHealthy(watch,model,"fp32")).toBe(false);
  });
});

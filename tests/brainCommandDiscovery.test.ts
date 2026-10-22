import {describe,it,expect} from "vitest";
import {BRAIN_SUGGESTIONS} from "../src/core/commands/commandCatalog.js";
import {brainCommand} from "../src/core/commands/brainCommand.js";
import {registry} from "../src/core/commands/registry.js";
import {getDashboardSuggestions,getSuggestionDescriptions} from "../src/utils/dashboardSuggestions.js";
import type {ChatLine,SlashCommandContext} from "../src/core/commands/types.js";

describe("Brain CLI Phase 6 command help and autocomplete parity",()=>{
 it("registers the parent and alias, and advertises each CLI subcommand",()=>{
   expect(registry.get("brain")).toBe(brainCommand);
   expect(registry.get("scratch")).toBe(brainCommand);
   expect(new Set(BRAIN_SUGGESTIONS).size).toBe(BRAIN_SUGGESTIONS.length);
   expect(getDashboardSuggestions("/brain ")).toEqual(expect.arrayContaining([...BRAIN_SUGGESTIONS]));
   expect(getDashboardSuggestions("/scratch ")).toEqual(expect.arrayContaining(
     BRAIN_SUGGESTIONS.map(item=>item.replace(/^\/brain/,"/scratch"))));
 });
 it("completes nested tasks, recovery, aliases and delegate CLI variants",()=>{
   for(const [input,expected] of [
     ["/brain task.rec","/brain task.reconcile"],
     ["/brain artifact.rec","/brain artifact.recover"],
     ["/brain clean.con","/brain clean.confirm"],
     ["/scratch task.res","/scratch task.resume"],
     ["/brain delegate.start cla","/brain delegate.start claude"],
   ])expect(getDashboardSuggestions(input)).toContain(expected);
   expect(getDashboardSuggestions("/brain task.cred")).not.toContain("/brain task.credential.rotate");
   expect(getDashboardSuggestions("/brain delegate.promote.batch")).toEqual([]);
 });
 it("maintains consistent help, command validation and descriptions",async()=>{
   const lines:ChatLine[]=[];
   const context={agent:null,addLine:(line:ChatLine)=>{lines.push(line);}} as SlashCommandContext;
   await brainCommand.execute("help",context);
   const message=String(lines[0].content);
   for(const suggestion of BRAIN_SUGGESTIONS)expect(message).toContain(suggestion);
   expect(message).toContain("MCP-only");
   expect(message).toContain("task.credential.rotate");
   const descriptions=getSuggestionDescriptions();
   for(const suggestion of BRAIN_SUGGESTIONS) {
      expect(descriptions[suggestion]?.length).toBeGreaterThan(7);
      expect(descriptions[suggestion.replace(/^\/brain/,"/scratch")]?.length).toBeGreaterThan(7);
   }
 });
});

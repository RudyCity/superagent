#!/usr/bin/env bun
/** Interactive controller for manual operation without requiring an MCP client. */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  closeLanSession, discoverLanDevices, execLanCommand,
  listLanDevices, openLanSession, pairLanDevice, revokeLanDevice,
} from "./core/lanRemote/controller.js";
async function main() {
  const rl = readline.createInterface({ input, output });
  console.log("SuperAgent LAN Controller — Private network only");
  console.log("Commands: discover <segment> | pair | list | open | exec | close | revoke | quit");
  try {
    while (true) {
      const line = (await rl.question("lan> ")).trim().toLowerCase();
      if (line === "quit" || line === "exit") break;
      try {
        if (line === "discover" || line.startsWith("discover ")) {
          const segment = line === "discover"
            ? (await rl.question("Required network segment name: ")).trim()
            : line.slice("discover ".length).trim();
          console.log(JSON.stringify(await discoverLanDevices(segment), null, 2));
        }
        else if (line === "list") console.log(JSON.stringify(listLanDevices(), null, 2));
        else if (line === "pair") {
          const host = (await rl.question("Target IPv4: ")).trim();
          const fingerprint = (await rl.question("Full target SHA-256 fingerprint: ")).trim();
          const code = (await rl.question("8-digit pairing code: ")).trim();
          console.log("Approve pairing on target laptop.");
          console.log(JSON.stringify(await pairLanDevice({ host, fingerprint, code }), null, 2));
        } else if (line === "open") {
          const id = (await rl.question("Device ID: ")).trim();
          console.log("Approve session on target laptop.");
          console.log(JSON.stringify(await openLanSession(id), null, 2));
        } else if (line === "exec") {
          const id = (await rl.question("Device ID: ")).trim();
          const command = (await rl.question("Remote command: ")).trim();
          console.log(JSON.stringify(await execLanCommand(id, command), null, 2));
        } else if (line === "close") {
          const id = (await rl.question("Device ID: ")).trim();
          await closeLanSession(id); console.log("Session closed.");
        } else if (line === "revoke") {
          const id = (await rl.question("Device ID: ")).trim();
          await revokeLanDevice(id); console.log("Paired device revoked.");
        } else console.log("Commands: discover <segment> | pair | list | open | exec | close | revoke | quit");
      } catch (error) { console.error(error instanceof Error ? error.message : error); }
    }
  } finally { rl.close(); }
}
void main();

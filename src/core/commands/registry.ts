import { SlashCommand } from "./types.js";

class CommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(command: SlashCommand) {
    this.commands.set(command.name.toLowerCase(), command);
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.commands.set(alias.toLowerCase(), command);
      }
    }
  }

  unregister(name: string) {
    const command = this.commands.get(name.toLowerCase());
    if (command) {
      this.commands.delete(name.toLowerCase());
      if (command.aliases) {
        for (const alias of command.aliases) {
          this.commands.delete(alias.toLowerCase());
        }
      }
    }
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name.toLowerCase());
  }

  getAll(): SlashCommand[] {
    return Array.from(new Set(this.commands.values()));
  }
}

export const registry = new CommandRegistry();

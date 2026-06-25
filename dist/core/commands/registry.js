class CommandRegistry {
    commands = new Map();
    register(command) {
        this.commands.set(command.name.toLowerCase(), command);
        if (command.aliases) {
            for (const alias of command.aliases) {
                this.commands.set(alias.toLowerCase(), command);
            }
        }
    }
    unregister(name) {
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
    get(name) {
        return this.commands.get(name.toLowerCase());
    }
    getAll() {
        return Array.from(new Set(this.commands.values()));
    }
}
export const registry = new CommandRegistry();
//# sourceMappingURL=registry.js.map
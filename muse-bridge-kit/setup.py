#!/usr/bin/env python3
"""Interactive setup for the Muse<->superagent Telegram bridge kit.

Collects bot identities and group info, writes bridge-config.json,
and prints next steps. Tokens are NEVER stored here — Bot A's token
goes through Muse's secure vault (credentials flow), never in a file.
"""
import json, os, sys

KIT = os.path.dirname(os.path.abspath(__file__))
EXAMPLE = os.path.join(KIT, "bridge-config.example.json")
CONFIG = os.path.join(KIT, "bridge-config.json")

def ask(prompt, default=""):
    suffix = f" [{default}]" if default else ""
    v = input(f"{prompt}{suffix}: ").strip()
    return v or default

def main():
    print("=== Muse<->superagent Bridge Setup ===\n")
    if os.path.exists(CONFIG):
        print(f"Found existing {CONFIG}. Overwrite? (y/N)")
        if input().strip().lower() != "y":
            print("Aborted.")
            return

    with open(EXAMPLE) as f:
        cfg = json.load(f)

    print("--- Bot A (Muse's bot, the one YOU control) ---")
    print("Create via @BotFather if needed. Token goes in Muse's secure vault, NOT here.")
    cfg["bot_a"]["username"] = ask("Bot A username (e.g. @my_muse_bot)")
    cfg["bot_a"]["id"] = int(ask("Bot A numeric id (from @userinfobot or getMe)"))

    print("\n--- Bot B (superagent's bot, runs on the laptop) ---")
    cfg["bot_b"]["username"] = ask("Bot B username (e.g. @my_superagent_bot)")
    cfg["bot_b"]["id"] = int(ask("Bot B numeric id"))

    print("\n--- Private Telegram group ---")
    print("Create a private group, add BOTH bots as admins,")
    print("and enable Bot-to-Bot Communication Mode for both in @BotFather.")
    cfg["group"]["name"] = ask("Group name")
    cfg["group"]["id"] = int(ask("Group chat id (negative number, e.g. -1234567890)"))

    with open(CONFIG, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"\nWrote {CONFIG}")
    print("\nNext steps:")
    print("1. Store Bot A's token in Muse's secure vault (credentials flow).")
    print("2. Copy skills/superagent-bridge/ and skills/telegram-bot/ into ~/workspace/skills/.")
    print("3. Copy tg-relay/ contents into ~/workspace/tg-relay/.")
    print("4. Create the cron job from docs/cron-template.md (fill in your chat_id).")
    print("5. On the laptop: follow docs/superagent-setup.md to configure superagent.")
    print("6. Send /muse hai from superagent to test the loop.")

if __name__ == "__main__":
    main()

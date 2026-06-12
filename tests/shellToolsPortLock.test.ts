import { describe, it, expect, vi, beforeEach } from "vitest";
import { adjustCommandPorts } from "../src/core/tools/shellTools.js";
import net from "net";

describe("shellTools Port Lock & Dynamic Port Allocation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("adjustCommandPorts", () => {
    it("should dynamically offset ports when they are already in use", async () => {
      // Mock net.createServer to fail once (port in use) and succeed next (port free)
      let listenCount = 0;
      const mockServer = {
        once: vi.fn().mockImplementation((event, cb) => {
          if (event === "error" && listenCount === 0) {
            // Trigger error (port in use)
            setTimeout(cb, 5);
          } else if (event === "listening" && listenCount === 1) {
            // Trigger listening (port free)
            setTimeout(cb, 5);
          }
        }),
        listen: vi.fn().mockImplementation(() => {
          listenCount++;
        }),
        close: vi.fn(),
      };
      
      vi.spyOn(net, "createServer").mockReturnValue(mockServer as any);

      const command = "npm run start --port 3000";
      const adjusted = await adjustCommandPorts(command);

      expect(adjusted).toBe("npm run start --port 3001");
    });

    it("should keep port same if it is free", async () => {
      const mockServer = {
        once: vi.fn().mockImplementation((event, cb) => {
          if (event === "listening") {
            setTimeout(cb, 5);
          }
        }),
        listen: vi.fn(),
        close: vi.fn(),
      };
      
      vi.spyOn(net, "createServer").mockReturnValue(mockServer as any);

      const command = "npm run start --port 3000";
      const adjusted = await adjustCommandPorts(command);

      expect(adjusted).toBe("npm run start --port 3000");
    });
  });
});

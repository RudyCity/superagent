import { useEffect } from "react";

/**
 * Hook to enable mouse wheel scroll support in the terminal for the single-agent app.
 * Listens for SGR extended mouse events (scroll up = button 64, scroll down = button 65)
 * and calls the provided scrollChat callback accordingly.
 */
export function useMouseScroll(
  scrollChat: (direction: "up" | "down", amount?: number) => void
) {
  useEffect(() => {
    if (!process.stdin.isTTY) return;

    // Enable SGR extended mouse tracking (button events + SGR coordinates)
    const enableMouseTracking = "\x1b[?1000h\x1b[?1006h";
    const disableMouseTracking = "\x1b[?1006l\x1b[?1000l";

    const handleMouseInput = (data: Buffer) => {
      const text = data.toString("utf8");
      // Match SGR mouse events: ESC[<button;col;row[Mm]
      const matches = text.matchAll(/\x1b\[<(?<btn>\d+);(?<col>\d+);(?<row>\d+)(?<action>[Mm])/g);

      for (const match of matches) {
        const btn = match.groups?.btn;

        if (btn === "64") {
          // Scroll up
          scrollChat("up");
        } else if (btn === "65") {
          // Scroll down
          scrollChat("down");
        }
      }
    };

    process.stdout.write(enableMouseTracking);
    process.stdin.on("data", handleMouseInput);

    return () => {
      process.stdin.off("data", handleMouseInput);
      process.stdout.write(disableMouseTracking);
    };
  }, [scrollChat]);
}

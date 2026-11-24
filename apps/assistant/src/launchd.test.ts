import { describe, expect, it } from "vitest";
import { renderPlist } from "./launchd";

describe("renderPlist", () => {
  it("renders a launch agent that starts the built daemon", () => {
    const plist = renderPlist({
      projectRoot: "/Users/me/My & Assistant",
      nodePath: "/usr/local/bin/node",
      distPath: "/Users/me/My & Assistant/dist/assistant.js",
      logDir: "/Users/me/My & Assistant/data/logs",
    });

    expect(plist).toContain("<string>com.myassistant.agent</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("--daemon");
    expect(plist).toContain("My &amp; Assistant");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("daemon.err.log");
  });
});

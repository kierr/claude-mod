import { describe, it, expect } from "bun:test";
import { parseArgs, getOrderedPatches, isSupportedVersion } from "../../bin/patch.cjs";

describe("Argument Parser", () => {
  describe("help command", () => {
    it("should parse help flag", () => {
      const result = parseArgs(["--help"]);
      expect(result).toEqual({ command: "help" });
    });

    it("should parse -h flag", () => {
      const result = parseArgs(["-h"]);
      expect(result).toEqual({ command: "help" });
    });

    it("should parse no args as help", () => {
      const result = parseArgs([]);
      expect(result).toEqual({ command: "help" });
    });
  });

  describe("list command (compat shim for status --all)", () => {
    it("should parse list command", () => {
      const result = parseArgs(["list"]);
      expect(result).toEqual({ command: "status", all: true, deprecatedList: true });
    });

    it("should ignore extra arguments", () => {
      const result = parseArgs(["list", "extra"]);
      expect(result).toEqual({ command: "status", all: true, deprecatedList: true });
    });
  });

  describe("clean command", () => {
    it("should parse clean with version", () => {
      const result = parseArgs(["clean", "2.1.92"]);
      expect(result).toEqual({ command: "clean", version: "2.1.92" });
    });

    it("should throw error when version missing", () => {
      expect(() => parseArgs(["clean"])).toThrow("version required for clean command");
    });
  });

  describe("status command", () => {
    it("should parse status with version", () => {
      const result = parseArgs(["status", "2.1.92"]);
      expect(result).toEqual({ command: "status", version: "2.1.92" });
    });

    it("should parse status --all", () => {
      const result = parseArgs(["status", "--all"]);
      expect(result).toEqual({ command: "status", all: true });
    });

    it("should throw error when version missing", () => {
      expect(() => parseArgs(["status"])).toThrow("version required for status command");
    });

    it("should parse explicit help command", () => {
      expect(parseArgs(["help"])).toEqual({ command: "help" });
    });
  });

  describe("update command", () => {
    it("should parse update without an explicit version", () => {
      expect(parseArgs(["update"])).toEqual({ command: "update", version: null });
    });

    it("should parse update with version", () => {
      expect(parseArgs(["update", "2.1.92"])).toEqual({ command: "update", version: "2.1.92" });
    });
  });

  describe("doctor command", () => {
    it("should parse doctor", () => {
      expect(parseArgs(["doctor"])).toEqual({ command: "doctor" });
    });
  });

  describe("new-patch command", () => {
    it("should parse new-patch with id", () => {
      expect(parseArgs(["new-patch", "my_gate"])).toEqual({ command: "new-patch", patchId: "my_gate" });
    });

    it("should throw without id", () => {
      expect(() => parseArgs(["new-patch"])).toThrow("patch id required");
    });

    it("should throw on non-snake id", () => {
      expect(() => parseArgs(["new-patch", "My-Gate"])).toThrow("invalid patch id");
    });
  });

  describe("patch command", () => {
    it("should parse explicit patch subcommand", () => {
      const result = parseArgs(["patch", "2.1.92"]);
      expect(result.command).toBe("patch");
      expect(result.version).toBe("2.1.92");
      expect(result.patches).toEqual(getOrderedPatches());
      expect(result.verbose).toBe(false);
    });

    it("should parse bare version as patch shorthand", () => {
      const result = parseArgs(["2.1.92"]);
      expect(result.command).toBe("patch");
      expect(result.version).toBe("2.1.92");
      expect(result.patches).toEqual(getOrderedPatches());
    });

    it("should parse bare version with --verbose", () => {
      const result = parseArgs(["2.1.92", "--verbose"]);
      expect(result.command).toBe("patch");
      expect(result.version).toBe("2.1.92");
      expect(result.verbose).toBe(true);
    });

    it("should reject --all (removed flag)", () => {
      expect(() => parseArgs(["patch", "2.1.92", "--all"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should reject --dry-run (removed flag)", () => {
      expect(() => parseArgs(["patch", "2.1.92", "--dry-run"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should reject --json (removed flag)", () => {
      expect(() => parseArgs(["patch", "2.1.92", "--json"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should reject positional patch IDs", () => {
      expect(() => parseArgs(["patch", "2.1.92", "unlock_agent_models"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should reject shorthand patch flags", () => {
      expect(() => parseArgs(["patch", "2.1.92", "--relax-model-enum"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should throw error when version missing", () => {
      expect(() => parseArgs(["patch"])).toThrow("version required for patch command");
    });

    it("should parse --verbose flag", () => {
      const result = parseArgs(["patch", "2.1.92", "--verbose"]);
      expect(result.verbose).toBe(true);
    });

    it("should parse -v flag", () => {
      const result = parseArgs(["patch", "2.1.92", "-v"]);
      expect(result.verbose).toBe(true);
    });
  });

  describe("run command", () => {
    it("should always return full ordered patch set", () => {
      const result = parseArgs(["run", "2.1.92"]);
      expect(result.command).toBe("run");
      expect(result.version).toBe("2.1.92");
      expect(result.patches).toEqual(getOrderedPatches());
      expect(result.cliArgs).toEqual([]);
      expect(result.verbose).toBe(false);
    });

    it("should reject --all (removed flag)", () => {
      expect(() => parseArgs(["run", "2.1.92", "--all"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should reject positional patch IDs", () => {
      expect(() => parseArgs(["run", "2.1.92", "unlock_agent_models"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should reject shorthand patch flags", () => {
      expect(() => parseArgs(["run", "2.1.92", "--relax-model-enum"]))
        .toThrow("Per-patch selection is not supported");
    });

    it("should parse run with separator and CLI args", () => {
      const result = parseArgs(["run", "2.1.92", "--", "--help", "--version"]);
      expect(result.patches).toEqual(getOrderedPatches());
      expect(result.cliArgs).toEqual(["--help", "--version"]);
    });

    it("leaves an omitted run version for verified-default resolution", () => {
      const result = parseArgs(["run"]);
      expect(result.command).toBe("run");
      expect(result.version).toBeUndefined();
    });

    it("rejects the removed background patch command", () => {
      expect(() => parseArgs(["__bg_patch", "2.1.136"])).toThrow("Unknown command");
    });
  });

  describe("unknown command", () => {
    it("should throw error for unknown command", () => {
      expect(() => parseArgs(["unknown"])).toThrow("Unknown command: unknown");
    });

    it("should throw error for invalid command", () => {
      expect(() => parseArgs(["invalid", "args"])).toThrow("Unknown command: invalid");
    });
  });

  describe("edge cases", () => {
    it("should handle arguments with special characters after separator", () => {
      const result = parseArgs(["run", "2.1.92", "--", "--arg=value", "--flag"]);
      expect(result.cliArgs).toEqual(["--arg=value", "--flag"]);
    });

    it("should handle version with various formats", () => {
      const result1 = parseArgs(["patch", "2.1.92"]);
      expect(result1.version).toBe("2.1.92");

      const result2 = parseArgs(["patch", "2.0.50"]);
      expect(result2.version).toBe("2.0.50");

      const result3 = parseArgs(["patch", "2.1.112-beta"]);
      expect(result3.version).toBe("2.1.112-beta");
    });

    it("should allow supported versions (native binary era, >= 2.1.113)", () => {
      const result1 = parseArgs(["patch", "2.1.113"]);
      expect(result1.version).toBe("2.1.113");

      const result2 = parseArgs(["patch", "2.1.117"]);
      expect(result2.version).toBe("2.1.117");
    });

    it("should allow clean/status on any version", () => {
      const cleanResult = parseArgs(["clean", "2.1.113"]);
      expect(cleanResult.command).toBe("clean");
      expect(cleanResult.version).toBe("2.1.113");

      const statusResult = parseArgs(["status", "2.1.113"]);
      expect(statusResult.command).toBe("status");
      expect(statusResult.version).toBe("2.1.113");
    });
  });

  describe("isSupportedVersion", () => {
    it("rejects versions below the 2.1.113 floor", () => {
      expect(isSupportedVersion("2.1.112")).toBe(false);
    });

    it("accepts the floor version and everything above", () => {
      expect(isSupportedVersion("2.1.113")).toBe(true);
      expect(isSupportedVersion("2.1.178")).toBe(true);
    });
  });
});

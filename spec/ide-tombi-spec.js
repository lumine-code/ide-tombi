const { resolver, serverContext, installContext, serverApi } = require("./helpers/server-resolver");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const register = (main, service = {}) => {
  let adapter;
  const registration = { dispose: jasmine.createSpy("dispose adapter edge") };
  const disposable = main.consumeIdeClient({
    registerAdapter(value) {
      adapter = value;
      return registration;
    },
    ...service,
  });
  return { adapter, registration, disposable };
};

describe("ide-tombi adapter", () => {
  let main, adapter, disposable;
  beforeEach(async () => {
    const pkg = await lumine.packages.activatePackage("ide-tombi");
    main = pkg.mainModule;
    ({ adapter, disposable } = register(main));
  });
  afterEach(async () => {
    disposable?.dispose();
    for (const key of [
      "serverPath",
      "offline",
      "tomlVersion",
      "formatterLineWidth",
      "schemaAssociations",
    ])
      lumine.config.unset(`ide-tombi.${key}`);
    await lumine.packages.deactivatePackage("ide-tombi");
  });

  it("registers TOML with the shared client and root-scoped sessions", () => {
    expect(adapter.id).toBe("ide-tombi");
    expect(adapter.grammarScopes).toEqual(["source.toml"]);
    expect(adapter.languageId).toBe("toml");
    expect(adapter.sessionScope).toBe("project-root");
    expect(adapter.settingsKeyPaths).toEqual(["ide-tombi"]);
    expect(adapter.restartKeyPaths).toEqual(["ide-tombi.serverPath", "ide-tombi.offline"]);
    expect(adapter.installServer).toEqual(jasmine.any(Function));
    expect(adapter.latestServerVersion).toEqual(jasmine.any(Function));
    expect(adapter.managedServer).toBeUndefined();
  });

  it("returns the exact provider-edge disposable", () => {
    const edge = register(main);
    expect(edge.disposable).toBe(edge.registration);
    edge.disposable.dispose();
    expect(edge.registration.dispose).toHaveBeenCalledTimes(1);
  });

  it("leaves native defaults and project settings with Tombi", () => {
    expect(adapter.getSettings()).toEqual({ tombi: {} });
    expect(adapter.getWorkspaceConfiguration).toBeUndefined();
  });

  it("sends native kebab-case fallback options without client-only settings", () => {
    const schemas = [{ path: "https://example.com/app.json", include: ["app.toml"] }];
    lumine.config.set("ide-tombi.tomlVersion", "v1.1.0");
    lumine.config.set("ide-tombi.formatterLineWidth", 120);
    lumine.config.set("ide-tombi.schemaAssociations", schemas);
    lumine.config.set("ide-tombi.offline", true);
    expect(adapter.getSettings()).toEqual({
      tombi: { "toml-version": "v1.1.0", format: { rules: { "line-width": 120 } }, schemas },
    });
  });

  it("launches the configured executable with the project cwd and native stdio", async () => {
    lumine.config.set("ide-tombi.serverPath", process.execPath);
    lumine.config.set("ide-tombi.offline", true);
    expect(await adapter.resolveServer(serverContext({ rootPath: __dirname }))).toEqual({
      command: process.execPath,
      args: ["lsp", "--offline"],
      cwd: __dirname,
      transport: "stdio",
    });
  });

  it("normalizes native absolute schema paths without rewriting remote URLs", () => {
    const absolute = path.join(__dirname, "schema with spaces.json");
    lumine.config.set("ide-tombi.schemaAssociations", [
      { path: absolute, include: ["app.toml"] },
      { path: "https://example.com/schema.json", include: ["app.toml"] },
    ]);
    expect(adapter.getSettings().tombi.schemas.map(({ path: schemaPath }) => schemaPath)).toEqual([
      pathToFileURL(absolute).href,
      "https://example.com/schema.json",
    ]);
  });

  it("warns once and drops paths the editor configuration cannot resolve", () => {
    spyOn(lumine.notifications, "addWarning");
    lumine.config.set("ide-tombi.schemaAssociations", [
      { path: "relative-only/spec-schema.json", include: ["app.toml"] },
    ]);
    expect(adapter.getSettings()).toEqual({ tombi: {} });
    expect(adapter.getSettings()).toEqual({ tombi: {} });
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
    expect(lumine.notifications.addWarning.calls.mostRecent().args[1].detail).toContain(
      "tombi.toml",
    );
  });

  it("reports a missing server through the hub", async () => {
    spyOn(resolver, "select").and.resolveTo(null);
    const reportMissingServer = jasmine.createSpy("report missing server");
    const edge = register(main, { reportMissingServer });
    expect(await edge.adapter.resolveServer(serverContext({ rootPath: __dirname }))).toBeNull();
    expect(reportMissingServer).toHaveBeenCalledTimes(1);
    expect(reportMissingServer.calls.mostRecent().args[0]).toBe("ide-tombi");
    expect(reportMissingServer.calls.mostRecent().args[1].description).toContain("Tombi");
    edge.disposable.dispose();
  });

  it("rejects a bad explicit path instead of silently using another server", async () => {
    lumine.config.set("ide-tombi.serverPath", path.join(__dirname, "missing-tombi"));
    await expectAsync(
      adapter.resolveServer(
        serverContext({
          rootPath: __dirname,
          managedServer: { binaryPath: process.execPath },
        }),
      ),
    ).toBeRejected();
  });

  it("offers one accurate background tip", () => {
    const tips = main.provideBackgroundTips();
    expect(tips.packageName).toBe("ide-tombi");
    expect(tips.tips).toHaveSize(1);
    expect(tips.tips[0]).toContain("#:schema");
  });

  it("reloads the consumer generation and returns a fresh registration", async () => {
    const first = main;
    disposable.dispose();
    disposable = null;
    await lumine.packages.deactivatePackage("ide-tombi");
    await lumine.packages.unloadPackage("ide-tombi");
    await lumine.packages.loadPackage("ide-tombi");
    const pkg = await lumine.packages.activatePackage("ide-tombi");
    main = pkg.mainModule;
    expect(main).not.toBe(first);
    ({ adapter, disposable } = register(main));
    expect(adapter.id).toBe("ide-tombi");
    expect(main.provideBackgroundTips().packageName).toBe("ide-tombi");
  });

  it("exposes only supported feature switches", () => {
    const { configSchema } = require("../package.json");
    expect(Object.keys(configSchema.features.properties)).toEqual([
      "diagnostics",
      "autocomplete",
      "hover",
      "definition",
      "references",
      "symbols",
      "format",
      "codeActions",
      "inlayHints",
      "semanticTokens",
    ]);
    for (const [name, definition] of Object.entries(configSchema.features.properties)) {
      expect(definition.default).toBe(true);
      expect(lumine.config.get(`ide-tombi.features.${name}`)).toBe(true);
    }
  });
});

describe("ide-tombi server resolution and installation", () => {
  let server, directory;
  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-tombi");
    server = require("../lib/server");
    directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "ide-tombi-install-"),
    );
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-tombi");
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it("returns null when the executable is absent", async () => {
    spyOn(resolver, "select").and.resolveTo(null);
    expect(await server.resolveServer(serverContext(), "")).toBeNull();
  });

  it("rejects a directory selected as an executable", async () => {
    await expectAsync(server.resolveServer(serverContext(), directory)).toBeRejectedWithError(
      /must name a file/,
    );
  });

  it("names only upstream native release targets and exact versioned archives", () => {
    const targets = {
      "win32-x64": "x86_64-pc-windows-msvc.zip",
      "win32-arm64": "aarch64-pc-windows-msvc.zip",
      "darwin-x64": "x86_64-apple-darwin.tar.gz",
      "darwin-arm64": "aarch64-apple-darwin.tar.gz",
      "linux-x64": "x86_64-unknown-linux-musl.tar.gz",
      "linux-arm64": "aarch64-unknown-linux-musl.tar.gz",
      "linux-arm": "arm-unknown-linux-gnueabihf.tar.gz",
    };
    for (const [key, target] of Object.entries(targets)) {
      const [platform, arch] = key.split("-");
      expect(server.assetFor({ platform, arch, version: "v1.7.1" })).toBe(
        `tombi-cli-1.7.1-${target}`,
      );
    }
    expect(server.assetFor({ platform: "linux", arch: "ia32", version: "1.7.1" })).toBeNull();
    expect(server.assetFor({ platform: "linux", arch: "x64", version: "../invalid" })).toBeNull();
  });

  const installerApi = (digest = `sha256:${"a".repeat(64)}`) => {
    const name = server.assetFor({
      platform: process.platform,
      arch: process.arch,
      version: "1.7.1",
    });
    const release = {
      version: "1.7.1",
      assets: [{ name, url: "https://example.com/archive", digest }],
    };
    return {
      latestGithubRelease: jasmine.createSpy("latest").and.resolveTo(release),
      githubReleaseByTag: jasmine.createSpy("by tag").and.resolveTo(release),
      setServerInstallationStatus: jasmine.createSpy("status"),
      downloadFile: jasmine
        .createSpy("verified download")
        .and.callFake(async (_url, destination) => {
          const nested = path.join(destination, "tombi-cli", "bin");
          fs.mkdirSync(nested, { recursive: true });
          fs.writeFileSync(
            path.join(nested, process.platform === "win32" ? "tombi.exe" : "tombi"),
            "binary",
          );
          fs.writeFileSync(path.join(destination, "LICENSE"), "upstream license");
        }),
      makeFileExecutable: jasmine.createSpy("chmod").and.resolveTo(),
    };
  };

  it("verifies the selected release digest and preserves the archive tree", async () => {
    const api = installerApi();
    const installed = await server.installServer(
      installContext({ storagePath: directory, version: "1.7.1", api }),
    );
    expect(api.githubReleaseByTag).toHaveBeenCalledWith("tombi-toml/tombi", "v1.7.1");
    expect(api.downloadFile).toHaveBeenCalledWith("https://example.com/archive", directory, {
      type: process.platform === "win32" ? "zip" : "gzip-tar",
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(fs.existsSync(path.join(directory, installed.binary))).toBe(true);
    expect(fs.readFileSync(path.join(directory, "LICENSE"), "utf8")).toBe("upstream license");
    expect(installed.version).toBe("1.7.1");
    expect(api.makeFileExecutable).toHaveBeenCalledWith(path.join(directory, installed.binary));
  });

  it("refuses an unverified archive before downloading", async () => {
    const api = installerApi("");
    await expectAsync(
      server.installServer(installContext({ storagePath: directory, api })),
    ).toBeRejectedWithError(/SHA256/);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("refuses a release missing the expected target", async () => {
    const api = installerApi();
    api.latestGithubRelease.and.resolveTo({ version: "1.7.1", assets: [] });
    await expectAsync(
      server.installServer(installContext({ storagePath: directory, api })),
    ).toBeRejectedWithError(/does not publish/);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("rejects an archive without the executable", async () => {
    const api = installerApi();
    api.downloadFile.and.resolveTo();
    await expectAsync(
      server.installServer(installContext({ storagePath: directory, api })),
    ).toBeRejectedWithError(/does not contain/);
  });

  it("reports the latest stable upstream version through the hub API", async () => {
    const api = installerApi();
    expect(await server.latestServerVersion(serverApi(api))).toBe("1.7.1");
    expect(api.latestGithubRelease).toHaveBeenCalledWith("tombi-toml/tombi");
  });
});

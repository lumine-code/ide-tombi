const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeFixture } = require("./helpers/fixture");

const serverPath =
  process.env.TOMBI_PATH || require("./helpers/server-resolver").findOnPath("tombi");
const liveSuite = serverPath ? describe : () => {};
const waitForSession = async (service, editor) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const session = (await service.activeSessionsForEditor(editor)).find(
      ({ adapter }) => adapter.id === "ide-tombi",
    );
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Tombi session did not start: ${JSON.stringify(service.getLog("ide-tombi"))}`);
};

liveSuite("ide-tombi through the real ide-client session", () => {
  let rootPath, editor, clientMain, service, originalProjects, originalTimeout;
  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    originalProjects = lumine.project.getPaths();
    rootPath = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-tombi-session-"));
    const fixture = writeFixture(rootPath);
    fs.writeFileSync(fixture.filePath, 'theme="dark"\n"😀żółć"=3\n');
    lumine.project.setPaths([rootPath]);
    lumine.config.set("ide-tombi.serverPath", serverPath);
    lumine.config.set("ide-tombi.offline", true);
    await lumine.packages.activatePackage("language-toml");
    const clientPackage = await lumine.packages.activatePackage("ide-client");
    clientMain = clientPackage.mainModule;
    service = clientMain.provideIdeClient();
    await lumine.packages.activatePackage("ide-tombi");
    editor = await lumine.workspace.open(fixture.filePath);
    await editor.whenGrammarSettled();
    expect(service.adaptersForEditor(editor).map(({ id }) => id)).toContain("ide-tombi");
    await waitForSession(service, editor);
  });
  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.deactivatePackage("ide-tombi");
    await lumine.packages.deactivatePackage("ide-client");
    await lumine.packages.deactivatePackage("language-toml");
    lumine.config.unset("ide-tombi.serverPath");
    lumine.config.unset("ide-tombi.offline");
    lumine.config.unset("ide-tombi.features.format");
    lumine.project.setPaths(originalProjects);
    await fs.promises.rm(rootPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it("routes a TOML editor to Tombi and applies provider edits to its real buffer", async () => {
    expect(editor.getGrammar().scopeName).toBe("source.toml");
    const session = await service.activeSessionForFeature(editor, "textDocument/formatting");
    expect(session.adapter.id).toBe("ide-tombi");
    expect(session.state).toBe("running");
    expect(session.serverInfo.version).toBe(process.env.TOMBI_VERSION || "1.7.1");
    const edits = await clientMain.provideCodeFormatFile().formatEntireFile(editor);
    expect(edits.length).toBeGreaterThan(0);
    editor.transact(() => {
      for (const edit of [...edits].reverse())
        editor.setTextInBufferRange(edit.oldRange, edit.newText);
    });
    expect(editor.getText()).toBe('theme = "dark"\n"😀żółć" = 3\n');
    lumine.config.set("ide-tombi.features.format", false);
    expect(await service.activeSessionForFeature(editor, "textDocument/formatting")).toBeNull();
    expect(session.state).toBe("running");
  });

  it("routes hover and pull diagnostics through the editor's actual session", async () => {
    const session = await service.activeSessionForEditor(editor);
    expect(session.adapter.id).toBe("ide-tombi");
    const uri = clientMain.manager.uriForEditor(editor);
    const hover = await service.request(editor, "textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 2 },
    });
    expect(hover.contents.value).toContain("Choose a display theme");
    editor.setText('theme = "wrong"\n');
    const report = await service.request(editor, "textDocument/diagnostic", {
      textDocument: { uri },
    });
    expect(report.items.length).toBeGreaterThan(0);
    expect(session.supports("textDocument/rename", editor)).toBe(false);
  });
});

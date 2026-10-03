const fs = require("fs");
const os = require("os");
const path = require("path");
const { LiveLspClient, fileUri, positionParams } = require("./helpers/live-lsp-client");
const { writeFixture, applyEdits } = require("./helpers/fixture");

// CI installs the official native release and supplies TOMBI_PATH. A fleet run
// without Tombi still exercises the adapter and verified installer contracts.
const serverPath = process.env.TOMBI_PATH || require("../lib/server").findOnPath("tombi");
const liveSuite = serverPath ? describe : () => {};

liveSuite("ide-tombi official Tombi server", () => {
  let client, disposable, rootPath, fixture, adapter;
  let originalTimeout;
  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    const pkg = await lumine.packages.activatePackage("ide-tombi");
    lumine.config.set("ide-tombi.serverPath", serverPath);
    lumine.config.set("ide-tombi.offline", true);
    disposable = pkg.mainModule.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
    });
    rootPath = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-tombi-live-"));
    fixture = writeFixture(rootPath);
    client = new LiveLspClient(adapter, rootPath);
  });
  afterEach(async () => {
    await client?.stop();
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
    await fs.promises.rm(rootPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  const open = async (source) => {
    fs.writeFileSync(fixture.filePath, source);
    await client.start();
    const uri = fileUri(fixture.filePath);
    client.open(uri, "toml", source);
    // The actual editor also negotiates pull diagnostics. A request is the
    // document-open barrier and gives assertions current, versioned reports.
    await client.request("textDocument/diagnostic", { textDocument: { uri } });
    return uri;
  };
  const diagnostics = (uri) => client.request("textDocument/diagnostic", { textDocument: { uri } });

  it("validates schemas and clears diagnostics after a UTF-16 document change", async () => {
    const source = 'theme = "dark"\n"😀żółć" = "wrong"\n';
    const uri = await open(source);
    const report = await diagnostics(uri);
    const mismatch = report.items.find(({ code }) => code === "type-mismatch");
    expect(mismatch.message).toContain("Integer");
    expect(mismatch.range).toEqual({
      start: { line: 1, character: 11 },
      end: { line: 1, character: 18 },
    });
    expect(client.initializeResult.capabilities.positionEncoding).toBe("utf-16");
    expect(client.initializeResult.serverInfo.name).toBe("Tombi LSP");
    if (process.env.TOMBI_VERSION)
      expect(client.initializeResult.serverInfo.version).toBe(process.env.TOMBI_VERSION);
    client.change(uri, 'theme = "dark"\n"😀żółć" = 3\n', 2);
    expect((await diagnostics(uri)).items).toEqual([]);
  });

  it("reports duplicate keys independently of schemas", async () => {
    const uri = await open('theme = "dark"\ntheme = "light"\n');
    const report = await diagnostics(uri);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.items.some(({ message }) => /duplicate|defined|conflict/i.test(message))).toBe(
      true,
    );
  });

  it("returns an enum completion whose real edit preserves surrounding Unicode", async () => {
    const source = '"😀żółć" = 3\ntheme = "d"\n';
    const uri = await open(source);
    const result = await client.request("textDocument/completion", positionParams(uri, 1, 10));
    const dark = (result.items || result).find(({ label }) => label === '"dark"');
    expect(dark.documentation.value).toContain("Choose a display theme");
    expect(applyEdits(source, [dark.textEdit])).toBe('"😀żółć" = 3\ntheme = "dark"\n');
  });

  it("serves hover documentation and navigation to the schema's actual key", async () => {
    const uri = await open('theme = "dark"\n');
    const hover = await client.request("textDocument/hover", positionParams(uri, 0, 2));
    expect(hover.contents.value).toContain("Choose a display theme");
    expect(hover.contents.value).toContain('"light"');
    const response = await client.request("textDocument/typeDefinition", positionParams(uri, 0, 2));
    const location = Array.isArray(response) ? response[0] : response;
    expect(location.uri).toContain("fixture.schema.json");
    const schemaLines = fs.readFileSync(fixture.schemaPath, "utf8").split("\n");
    const { start, end } = location.range;
    expect(schemaLines[start.line].slice(start.character, end.character)).toBe('"theme"');
  });

  it("returns hierarchical symbols, folding ranges and nonempty semantic tokens", async () => {
    const uri = await open('theme = "dark"\n\n[section]\nitem = 1\n');
    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
    expect(symbols.map(({ name }) => name)).toContain("theme");
    const section = symbols.find(({ name }) => name === "section");
    expect(section.children.map(({ name }) => name)).toEqual(["item"]);
    const tokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(tokens.data.length).toBeGreaterThan(0);
    expect(tokens.data.length % 5).toBe(0);
    const folds = await client.request("textDocument/foldingRange", { textDocument: { uri } });
    expect(folds.some(({ startLine, endLine }) => startLine === 2 && endLine >= 3)).toBe(true);
  });

  it("applies formatter edits without corrupting astral characters or accents", async () => {
    const source = 'theme="dark"\n"😀żółć"=3\n\n[section]\nitem=1\n';
    const uri = await open(source);
    const edits = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 8, insertSpaces: false },
    });
    expect(applyEdits(source, edits)).toBe('theme = "dark"\n"😀żółć" = 3\n\n[section]\nitem = 1\n');
  });

  it("preserves project configuration precedence over editor fallbacks", async () => {
    fs.appendFileSync(
      path.join(rootPath, "tombi.toml"),
      '\n[format.rules]\nstring-quote-style = "single"\n',
    );
    lumine.config.set("ide-tombi.tomlVersion", "v1.1.0");
    const source = 'theme="dark"\n';
    const uri = await open(source);
    const status = await client.request("tombi/getStatus", { uri });
    expect(status.configPath).toContain("tombi.toml");
    const edits = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(applyEdits(source, edits)).toBe("theme = 'dark'\n");
  });

  it("uses editor schema associations when no project configuration exists", async () => {
    fs.unlinkSync(path.join(rootPath, "tombi.toml"));
    lumine.config.set("ide-tombi.schemaAssociations", [
      { path: fixture.schemaPath, include: ["**/fixture.toml"] },
    ]);
    const uri = await open('theme = "invalid"\n');
    const report = await diagnostics(uri);
    expect(report.items.some(({ message }) => /enum|allowed|value/i.test(message))).toBe(true);
    client.change(uri, 'theme = "dark"\n', 2);
    expect((await diagnostics(uri)).items).toEqual([]);
    const hover = await client.request("textDocument/hover", positionParams(uri, 0, 2));
    expect(hover.contents.value).toContain("Choose a display theme");
  });

  it("leaves unsupported rename, signature help and code lens unavailable", async () => {
    const uri = await open('theme = "dark"\n');
    const capabilities = client.initializeResult.capabilities;
    expect(capabilities.renameProvider).toBeUndefined();
    expect(capabilities.signatureHelpProvider).toBeUndefined();
    expect(capabilities.codeLensProvider).toBeUndefined();
    await expectAsync(
      client.request("textDocument/rename", { ...positionParams(uri, 0, 2), newName: "mode" }),
    ).toBeRejectedWithError(/Method not found/);
  });
});

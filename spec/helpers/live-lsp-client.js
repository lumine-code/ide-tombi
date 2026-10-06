const { serverContext } = require("./server-resolver");
const childProcess = require("child_process");
const path = require("path");
const { configurationContext, workspaceConfiguration } = require(
  path.join(lumine.packages.resolvePackagePath("ide"), "lib", "workspace-configuration"),
);
const { pathToFileURL } = require("url");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} = require("vscode-jsonrpc/node");

const TIMEOUT_MS = 10000;

const withTimeout = (promise, label, timeout = TIMEOUT_MS) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
};

const capabilities = () => ({
  workspace: {
    applyEdit: true,
    configuration: true,
    workspaceFolders: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    diagnostics: { refreshSupport: true },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: true,
      didSave: true,
    },
    completion: {
      dynamicRegistration: true,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        resolveSupport: {
          properties: ["documentation", "detail", "additionalTextEdits", "command"],
        },
      },
    },
    hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
    signatureHelp: { dynamicRegistration: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
    documentHighlight: { dynamicRegistration: true },
    documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
    documentLink: { dynamicRegistration: true, tooltipSupport: true },
    colorProvider: { dynamicRegistration: true },
    foldingRange: { dynamicRegistration: true, lineFoldingOnly: false, rangeLimit: 5000 },
    selectionRange: { dynamicRegistration: true },
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    onTypeFormatting: { dynamicRegistration: true },
    rename: { dynamicRegistration: true, prepareSupport: true },
    codeAction: { dynamicRegistration: true, dataSupport: true },
    codeLens: { dynamicRegistration: true },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
    publishDiagnostics: {
      relatedInformation: true,
      tagSupport: { valueSet: [1, 2] },
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
  },
  window: { workDoneProgress: true, showDocument: { support: true } },
  general: { positionEncodings: ["utf-16"] },
});

class LiveLspClient {
  constructor(adapter, rootPath) {
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.notifications = [];
    this.registrations = [];
    this.stderr = "";
  }

  configurationContext() {
    return configurationContext(this.rootPath, this.launch, this.session, serverContext().resolver);
  }

  configuration(items) {
    return workspaceConfiguration(this.adapter, items, this.configurationContext());
  }

  async start() {
    const launch = await this.adapter.resolveServer(serverContext({ rootPath: this.rootPath }));
    this.launch = launch;
    this.child = childProcess.spawn(launch.command, launch.args || [], {
      cwd: launch.cwd || this.rootPath,
      env: { ...process.env, ...(launch.env || {}) },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
      {
        error: (message) => (this.stderr += `${message}\n`),
        warn: (message) => (this.stderr += `${message}\n`),
        info() {},
        log() {},
      },
    );
    this.connection.onNotification((method, params) => {
      this.notifications.push({ method, params });
    });
    this.connection.onRequest("workspace/configuration", ({ items }) => this.configuration(items));
    this.connection.onRequest("client/registerCapability", ({ registrations }) => {
      this.registrations.push(...registrations);
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", ({ unregistrations = [] }) => {
      const ids = new Set(unregistrations.map(({ id }) => id));
      this.registrations = this.registrations.filter(({ id }) => !ids.has(id));
      return null;
    });
    this.connection.onRequest("workspace/workspaceFolders", () => this.workspaceFolders);
    this.connection.onRequest("workspace/applyEdit", () => ({ applied: true }));
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("window/showDocument", () => ({ success: true }));
    this.connection.onRequest("workspace/diagnostic/refresh", () => {
      this.diagnosticRefreshes = (this.diagnosticRefreshes || 0) + 1;
      return null;
    });
    this.connection.listen();

    const rootUri = pathToFileURL(this.rootPath).href;
    this.workspaceFolders = [{ uri: rootUri, name: path.basename(this.rootPath) }];
    this.initializeResult = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "Lumine adapter integration specs", version: "1.0.0" },
      rootUri,
      workspaceFolders: this.workspaceFolders,
      capabilities: capabilities(),
      initializationOptions: await this.adapter.getInitializationOptions?.({
        ...serverContext({ rootPath: this.rootPath }),
        rootUri,
      }),
    });
    this.connection.sendNotification("initialized", {});
    const settings = (await this.adapter.getSettings?.(this.configurationContext())) ?? {};
    this.connection.sendNotification("workspace/didChangeConfiguration", { settings });
    return this.initializeResult;
  }

  request(method, params, timeout) {
    return withTimeout(
      this.connection.sendRequest(method, params),
      `${this.adapter.displayName} ${method}; stderr: ${this.stderr}`,
      timeout,
    );
  }

  notify(method, params) {
    return this.connection.sendNotification(method, params);
  }

  open(uri, languageId, text, version = 1) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  change(uri, text, version = 2) {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  closeDocument(uri) {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  messages(method) {
    return this.notifications.filter((message) => message.method === method);
  }

  async waitFor(check, label, timeout = TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label} timed out; stderr: ${this.stderr}`);
  }

  async stop() {
    if (!this.connection) return;
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else this.child.once("exit", resolve);
    });
    try {
      await withTimeout(this.connection.sendRequest("shutdown"), "shutdown", 2000);
      this.connection.sendNotification("exit");
    } catch {
      this.child?.kill();
    }
    try {
      await withTimeout(exited, "server exit", 2000);
    } catch {
      this.child.kill();
      await withTimeout(exited, "server exit after kill", 2000);
    }
    this.connection.dispose();
    this.connection = null;
  }
}

exports.LiveLspClient = LiveLspClient;
exports.fileUri = (filePath) => pathToFileURL(filePath).href;
exports.position = (line, character) => ({ line, character });
exports.positionParams = (uri, line, character) => ({
  textDocument: { uri },
  position: { line, character },
});

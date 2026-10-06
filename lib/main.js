const server = require("./server");
const path = require("path");
const { pathToFileURL } = require("url");

const setting = (name) => lumine.config.get(`ide-tombi.${name}`);
const warnedPaths = new Set();

const schemaAssociation = (schema) => {
  if (path.isAbsolute(schema.path)) return { ...schema, path: pathToFileURL(schema.path).href };
  try {
    if (["file:", "http:", "https:", "tombi:"].includes(new URL(schema.path).protocol))
      return { ...schema };
  } catch {
    // Editor configuration has no config-file directory for relative paths.
  }
  if (!warnedPaths.has(schema.path)) {
    warnedPaths.add(schema.path);
    lumine.notifications.addWarning("Ignoring an invalid path in ide-tombi schema associations.", {
      detail: `${schema.path}\nUse an absolute schema path or URL. Relative paths belong in the project's tombi.toml.`,
      dismissable: true,
    });
  }
  return null;
};

const settings = () => {
  const options = {};
  const version = setting("tomlVersion");
  if (version && version !== "default") options["toml-version"] = version;
  const lineWidth = setting("formatterLineWidth");
  if (lineWidth > 0) options.format = { rules: { "line-width": lineWidth } };
  const schemas = setting("schemaAssociations");
  if (schemas?.length) {
    // Tombi parses C:\\... as a URL with scheme "c". Absolute native paths
    // therefore need file URIs. Its editor config cannot resolve relative ones.
    const associations = schemas.map(schemaAssociation).filter(Boolean);
    if (associations.length) options.schemas = associations;
  }
  return { tombi: options };
};

module.exports = {
  consumeIdeClient(service) {
    return service.registerAdapter({
      id: "ide-tombi",
      displayName: "Tombi Language Server",
      grammarScopes: ["source.toml"],
      languageId: "toml",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-tombi"],
      restartKeyPaths: ["ide-tombi.serverPath", "ide-tombi.offline"],
      managedServerDisplayName: "Tombi",
      latestServerVersion: server.latestServerVersion,
      installServer: server.installServer,
      async resolveServer(context) {
        const launch = await server.resolveServer(
          context,
          setting("serverPath"),
          setting("offline"),
        );
        if (!launch) {
          service.reportMissingServer("ide-tombi", {
            description:
              "Install [Tombi](https://tombi-toml.github.io/tombi/docs/installation/) and make sure it is on your PATH, or set its location in the ide-tombi settings. The editor can also fetch it for you.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
      getSettings: settings,
    });
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-tombi",
      tips: [
        "Tombi uses JSON schemas to validate TOML keys and suggest values. Associate a schema in tombi.toml or add a #:schema directive to your document.",
      ],
    };
  },
};

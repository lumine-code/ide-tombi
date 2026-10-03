const server = require("./server");
const path = require("path");
const { pathToFileURL } = require("url");

const setting = (name) => lumine.config.get(`ide-toml.${name}`);

const settings = () => {
  const options = {};
  const version = setting("tomlVersion");
  if (version && version !== "default") options["toml-version"] = version;
  const lineWidth = setting("formatterLineWidth");
  if (lineWidth > 0) options.format = { rules: { "line-width": lineWidth } };
  const schemas = setting("schemaAssociations");
  if (schemas?.length)
    options.schemas = schemas.map((schema) => ({
      ...schema,
      // Tombi parses C:\\... as a URL with scheme "c". Absolute native paths
      // therefore need file URIs; relative paths retain the server's cwd.
      path: path.isAbsolute(schema.path) ? pathToFileURL(schema.path).href : schema.path,
    }));
  return { tombi: options };
};

module.exports = {
  consumeIdeClient(service) {
    return service.registerAdapter({
      id: "ide-toml",
      displayName: "Tombi Language Server",
      grammarScopes: ["source.toml"],
      languageId: "toml",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-toml"],
      restartKeyPaths: ["ide-toml.serverPath", "ide-toml.offline"],
      managedServerDisplayName: "Tombi",
      latestServerVersion: server.latestServerVersion,
      installServer: server.installServer,
      async resolveServer(context) {
        const launch = await server.resolveServer(
          setting("serverPath"),
          context.managedServer,
          setting("offline"),
        );
        if (!launch) {
          service.reportMissingServer("ide-toml", {
            description:
              "Install [Tombi](https://tombi-toml.github.io/tombi/docs/installation/) and make sure it is on your PATH, or set its location in the ide-toml settings. The editor can also fetch it for you.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
      getSettings: settings,
      getWorkspaceConfiguration(section) {
        const configuration = settings();
        return section === "tombi" ? configuration.tombi : section ? undefined : configuration;
      },
    });
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-toml",
      tips: [
        "Tombi uses JSON schemas to validate TOML keys and suggest values. Associate a schema in tombi.toml or add a #:schema directive to your document.",
      ],
    };
  },
};

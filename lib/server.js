const fs = require("fs");
const path = require("path");

const REPOSITORY = "tombi-toml/tombi";
const TARGETS = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-arm": "arm-unknown-linux-gnueabihf",
};

exports.assetFor = ({ platform, arch, version }) => {
  const target = TARGETS[`${platform}-${arch}`];
  const normalized = String(version || "").replace(/^v/, "");
  if (!target || !/^\d+\.\d+\.\d+$/.test(normalized)) return null;
  return `tombi-cli-${normalized}-${target}.${platform === "win32" ? "zip" : "tar.gz"}`;
};

exports.latestServerVersion = async (api) => (await api.latestGithubRelease(REPOSITORY)).version;

const locateBinary = (directory, name) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = locateBinary(candidate, name);
      if (nested) return nested;
    }
  }
  return null;
};

// Tombi publishes GitHub asset digests rather than checksum sidecars. Require
// one before handing the archive to the hub's verified download primitive.
exports.installServer = async ({ storagePath, version, api }) => {
  const release = version
    ? await api.githubReleaseByTag(REPOSITORY, `v${String(version).replace(/^v/, "")}`)
    : await api.latestGithubRelease(REPOSITORY);
  const assetName = exports.assetFor({
    platform: process.platform,
    arch: process.arch,
    version: release.version,
  });
  if (!assetName)
    throw new Error(`Tombi publishes no supported build for ${process.platform}-${process.arch}.`);
  const asset = release.assets.find(({ name }) => name === assetName);
  if (!asset) throw new Error(`Tombi ${release.version} does not publish '${assetName}'.`);
  if (!/^sha256:[0-9a-f]{64}$/i.test(asset.digest || ""))
    throw new Error(`Tombi did not publish a SHA256 digest for '${assetName}'.`);
  api.setServerInstallationStatus("downloading");
  await api.downloadFile(asset.url, storagePath, {
    type: process.platform === "win32" ? "zip" : "gzip-tar",
    digest: asset.digest,
  });
  const binary = locateBinary(storagePath, process.platform === "win32" ? "tombi.exe" : "tombi");
  if (!binary) throw new Error("The Tombi archive does not contain its executable.");
  await api.makeFileExecutable(binary);
  return {
    version: release.version,
    binary: path.relative(storagePath, binary),
    repository: REPOSITORY,
    asset: assetName,
    checksum: asset.digest,
  };
};

exports.resolveServer = async (context, configuredPath = "", offline = false) => {
  const selection = await context.resolver.select({
    kind: "executable",
    configuredPath,
    managedPath: context.managedServer?.binaryPath,
    managedVersion: context.managedServer?.version,
    env: context.env,
    cwd: context.rootPath,
    names: ["tombi"],
    signal: context.signal,
  });
  return selection
    ? context.resolver.launch(selection, {
        signal: context.signal,
        args: offline ? ["lsp", "--offline"] : ["lsp"],
      })
    : null;
};

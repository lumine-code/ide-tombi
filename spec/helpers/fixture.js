const fs = require("fs");
const path = require("path");

exports.writeFixture = (rootPath, { projectConfig = true } = {}) => {
  const schemaPath = path.join(rootPath, "fixture.schema.json");
  fs.writeFileSync(
    schemaPath,
    JSON.stringify(
      {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        title: "Fixture settings",
        additionalProperties: false,
        properties: {
          theme: {
            type: "string",
            enum: ["light", "dark"],
            description: "Choose a display theme.",
          },
          enabled: { type: "boolean", description: "Enable this feature." },
          count: { type: "integer" },
          "😀żółć": { type: "integer", description: "Unicode key." },
          section: {
            type: "object",
            properties: { item: { type: "integer" } },
            additionalProperties: false,
          },
        },
        required: ["theme"],
      },
      null,
      2,
    ),
  );
  if (projectConfig)
    fs.writeFileSync(
      path.join(rootPath, "tombi.toml"),
      '[schema.catalog]\npaths = []\n\n[[schemas]]\npath = "fixture.schema.json"\ninclude = ["fixture.toml"]\n',
    );
  return { schemaPath, filePath: path.join(rootPath, "fixture.toml") };
};

exports.applyEdits = (source, edits) => {
  const lines = source.split("\n");
  const offsetAt = ({ line, character }) =>
    lines.slice(0, line).reduce((total, text) => total + text.length + 1, 0) + character;
  return [...edits]
    .sort((a, b) => offsetAt(b.range.start) - offsetAt(a.range.start))
    .reduce(
      (text, { range, newText }) =>
        text.slice(0, offsetAt(range.start)) + newText + text.slice(offsetAt(range.end)),
      source,
    );
};

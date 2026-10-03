# ide-toml

Provide TOML language intelligence through Tombi.

Uses the native [Tombi language server](https://tombi-toml.github.io/tombi/) with the shared ide-client infrastructure and the language-toml grammar.

## Features

- **Schemas**: validate keys and values and suggest schema-aware completions.
- **Documentation**: display descriptions and expected types when hovering over keys.
- **Navigation**: expose document symbols, references, definitions and schema locations.
- **Formatting**: format TOML documents with the project's Tombi rules.
- **Code actions**: offer server-provided corrections and package-specific actions.
- **Highlighting**: supply semantic tokens and dependency inlay hints when available.
- **Managed server**: install native Tombi releases after verifying their SHA256 digest.

## Installation

To install `ide-toml` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-toml`.

Install `ide-client` and `language-toml`. The language server starts when a TOML editor opens. Use IDE Client's Manage Servers action to install Tombi, install it separately on PATH, or select an executable in this package's settings.

## Configuration

Tombi discovers `tombi.toml` or `.tombi.toml` beside a document or in its parent directories. That project configuration takes precedence over this package's fallback TOML version, line width and schema associations. Its formatting and schema rules remain under the project's control. See the [Tombi configuration reference](https://tombi-toml.github.io/tombi/docs/configuration/).

For a schema associated with a project's files:

```toml
[[schemas]]
path = "schemas/settings.schema.json"
include = ["settings.toml"]
```

A document can also name its schema directly:

```toml
#:schema https://example.com/settings.schema.json
enabled = true
```

Fallback schema associations in the package settings accept absolute local paths or schema URLs. Use `tombi.toml` for portable paths relative to the project.

Offline mode disables remote schema and package lookups while preserving local schemas. Tombi does not currently implement symbol rename, signature help or code lens, so this adapter offers no switches for them.

## Services

- `ide-client`: consumed to register the Tombi language-server adapter.
- `background-tips.provider`: provided to explain schema-aware TOML editing.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!

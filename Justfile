set shell := ["bash", "-uc"]

# Version stamped into the bundle. Overridden by the release workflow with the git tag.
version := `bun -e "console.log(require('./package.json').version)"`

_default:
    @just --list

# Install dependencies
install:
    bun install

# Biome (lint + format), TypeScript typecheck, and tests
checkall: lint typecheck test

# Lint and autofix with Biome
lint:
    bunx biome check --fix --unsafe

# Typecheck with tsc, no emit
typecheck:
    bunx tsc --noEmit

# Run the test suite
test:
    bun test

# Bundle the CLI into a single minified file runnable by bun with no install
# No --banner needed: bun carries over the shebang from src/main.ts, and a
# second one lands below `// @bun` where a shebang is a syntax error.
bundle v=version:
    @mkdir -p dist
    bun build src/main.ts \
        --target=bun \
        --minify \
        --define __VERSION__='"{{v}}"' \
        --outfile dist/infer.js
    @chmod +x dist/infer.js
    @echo "built dist/infer.js v{{v}} ($(wc -c < dist/infer.js | tr -d ' ') bytes)"

# Run the CLI from source
run *args:
    bun run src/main.ts {{args}}

# Remove build output
clean:
    rm -rf dist

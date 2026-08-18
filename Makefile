# Agent Conductor — build/test/package front door.
# `make help` lists targets. Checkers write one log each under reports/.

SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -ec
NPM   ?= npm
NODE  ?= node
REPORTS := reports

.DEFAULT_GOAL := help
.PHONY: help install doctor build watch lint typecheck test test-integration check check-all \
        package package-rich release registry-cache adr plan clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: doctor ## Verify prerequisites, then install dependencies (ci when lockfile exists)
	@if [ -f package-lock.json ]; then $(NPM) ci; else $(NPM) install; fi

doctor: ## Check required tools (node>=20, npm, git) and report optional agent CLIs
	@ok=1; \
	for t in node npm git; do command -v $$t >/dev/null 2>&1 || { echo "MISSING: $$t"; ok=0; }; done; \
	if command -v node >/dev/null 2>&1; then \
	  node -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' \
	    || { echo "node >= 20 required (have $$(node -v))"; ok=0; }; \
	fi; \
	for c in claude codex gemini copilot; do \
	  command -v $$c >/dev/null 2>&1 && echo "agent cli: $$c $$($$c --version 2>/dev/null | head -1)" \
	    || echo "agent cli: $$c — not found (optional; connect later via the wizard)"; \
	done; \
	test $$ok -eq 1

build: ## Bundle dist/extension.cjs + dist/mcp-shim.cjs (esbuild)
	$(NODE) esbuild.mjs

watch: ## Rebuild on change
	$(NODE) esbuild.mjs --watch

typecheck: ## tsc --noEmit → reports/tsc.log
	@mkdir -p $(REPORTS)
	npx tsc --noEmit 2>&1 | tee $(REPORTS)/tsc.log

lint: typecheck ## All static checks → reports/<tool>.log (eslint, core-import seam)
	@mkdir -p $(REPORTS)
	npx eslint src --max-warnings 0 2>&1 | tee $(REPORTS)/eslint.log
	@# Extraction seam (ADR-0003): src/core must not import vscode
	@! grep -rnE "from ['\"]vscode['\"]|require\(['\"]vscode['\"]\)" src/core \
	  | tee $(REPORTS)/core-imports.log | grep . \
	  || { echo "core-imports: OK" > $(REPORTS)/core-imports.log; true; }
	@test ! -s $(REPORTS)/core-imports.log -o "$$(cat $(REPORTS)/core-imports.log)" = "core-imports: OK" \
	  || { echo "FAIL: vscode import inside src/core (see $(REPORTS)/core-imports.log)"; exit 1; }

test: ## Unit tests incl. mock-ACP-agent protocol tests → reports/test.log
	@mkdir -p $(REPORTS)
	$(NPM) test 2>&1 | tee $(REPORTS)/test.log

test-integration: build ## VS Code extension host tests against the mock agent → reports/integration.log
	@mkdir -p $(REPORTS)
	$(NPM) run test:integration 2>&1 | tee $(REPORTS)/integration.log

check: build lint test ## Build + lint + unit tests
check-all: build lint test test-integration ## check + extension-host integration (release gate)

package: build ## Marketplace VSIX (stable APIs only)
	npx @vscode/vsce package --out dist/agent-conductor.vsix

package-rich: build ## Sideload VSIX with proposed APIs (chatSessions build)
	$(NODE) scripts/gen-rich-manifest.mjs && npx @vscode/vsce package --out dist/agent-conductor-rich.vsix; \
	$(NODE) scripts/gen-rich-manifest.mjs --restore

release: ## Full gate + both VSIX artifacts; tagging/publishing stay human actions
	@git diff --quiet && git diff --cached --quiet || { echo "working tree dirty — commit first"; exit 1; }
	$(MAKE) check-all package package-rich
	@v=$$(node -p "require('./package.json').version"); \
	echo ""; echo "release artifacts in dist/:"; ls -1 dist/*.vsix; \
	echo "next: git tag v$$v && git push --tags  (publish is manual — AGENTS.md)"

registry-cache: ## Refresh the cached ACP agent registry snapshot (dev aid)
	@mkdir -p .cache && curl -fsSL \
	  https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json \
	  -o .cache/acp-registry.json && echo "cached → .cache/acp-registry.json"

adr: ## New ADR: make adr NAME=short-kebab-title
	@test -n "$(NAME)" || { echo "usage: make adr NAME=short-kebab-title"; exit 1; }
	@last=$$(ls docs/adr | grep -E '^[0-9]{4}-' | sort | tail -1 | cut -c1-4); \
	next=$$(printf "%04d" $$((10#$${last:-0} + 1))); f="docs/adr/$$next-$(NAME).md"; \
	sed -e "s/{NUM}/$$next/g" -e "s/{TITLE}/$(NAME)/g" -e "s/{DATE}/$$(date +%F)/g" \
	  docs/adr/template.md > $$f && echo "$$f"

plan: ## New plan: make plan NAME=short-kebab-title
	@test -n "$(NAME)" || { echo "usage: make plan NAME=short-kebab-title"; exit 1; }
	@last=$$(ls docs/plans | grep -E '^[0-9]{4}-' | sort | tail -1 | cut -c1-4); \
	next=$$(printf "%04d" $$((10#$${last:-0} + 1))); f="docs/plans/$$next-$(NAME).md"; \
	printf "# %s\n\nStatus: draft — plans are temporary; promote durable decisions to ADRs (AGENTS.md).\n" \
	  "$(NAME)" > $$f && echo "$$f"

clean: ## Remove build artifacts, reports, caches
	rm -rf dist $(REPORTS) .cache .vscode-test

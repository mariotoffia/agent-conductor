# Agent Conductor — build/test/package front door.
# `make help` lists targets. Checkers write one log each under reports/.

# `.SHELLFLAGS` is only honoured by GNU make >= 3.82, and macOS ships 3.81, which
# ignores it in silence. A checker's failure would then be hidden by the `tee` it
# is piped into, and every gate would report success on a red branch — so pipefail
# is carried by SHELL itself, which both versions apply to every recipe line.
# `make gate-selftest` proves it still holds. Verified on 3.81 and 4.4.1.
SHELL := /bin/bash -o pipefail
.SHELLFLAGS := -o pipefail -ec
NPM   ?= npm
NODE  ?= node
REPORTS := reports
CORE_DIR ?= src/core
CORE_LOG ?= $(REPORTS)/core-imports.log

.DEFAULT_GOAL := help
.PHONY: help install doctor build watch lint typecheck core-imports gate-selftest pipe-probe \
        test test-integration check check-all package package-rich release registry-cache adr plan clean

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

lint: typecheck gate-selftest ## All static checks → reports/<tool>.log (eslint, core-import seam)
	@mkdir -p $(REPORTS)
	npx eslint src --max-warnings 0 2>&1 | tee $(REPORTS)/eslint.log
	@$(MAKE) --no-print-directory core-imports

# Extraction seam (ADR-0003). The pattern is any quoted `vscode`, not an import
# form: static import, dynamic `import()`, `require`, a backtick specifier and
# `createRequire` all reach the host module, and enumerating spellings is how a
# seam check ends up narrower than the rule it enforces. A legitimate quoted
# "vscode" in core does not exist — rephrase or move the code.
# grep says 0 when it finds a violation, 1 when the seam holds, and 2 when it
# could not look; a checker that could not look has not passed, so only 1 writes
# an OK. CORE_DIR/CORE_LOG let the self-test run this very recipe on a probe.
core-imports: ## Check the vscode-free seam over $(CORE_DIR)
	@mkdir -p $(REPORTS)
	@grep -rnE "['\"\`]vscode['\"\`]" $(CORE_DIR) > $(CORE_LOG); \
	  case $$? in \
	    0) echo "FAIL: vscode import inside $(CORE_DIR) (see $(CORE_LOG))"; exit 1 ;; \
	    1) echo "core-imports: OK" > $(CORE_LOG) ;; \
	    *) echo "FAIL: core-import check could not read $(CORE_DIR)"; exit 1 ;; \
	  esac

# A gate that cannot fail is worse than a red build: it reports success forever.
# Both halves of this have been real defects, so each gate run re-proves them.
gate-selftest: ## Prove the gates still fail when they should
	@tmp=$$(mktemp -d); rc=0; \
	  set -- 'import * as vscode from "vscode";' \
	         'const later = await import("vscode");' \
	         'const host = require(`vscode`);' \
	         'const host = createRequire(import.meta.url)("vscode");' \
	         '"vscode";'; \
	  for probe in "$$@"; do \
	    rm -rf $$tmp/core; mkdir -p $$tmp/core; \
	    printf '%s\n' "$$probe" > $$tmp/core/probe.ts; \
	    $(MAKE) --no-print-directory core-imports CORE_DIR=$$tmp/core CORE_LOG=$$tmp/log >/dev/null 2>&1 \
	      && { echo "FAIL: the seam check misses: $$probe"; rc=1; }; \
	  done; \
	  rm -rf $$tmp; test $$rc -eq 0
	@$(MAKE) --no-print-directory pipe-probe >/dev/null 2>&1 \
	  && { echo "FAIL: a failing command in a piped recipe reports success — check SHELL pipefail"; exit 1; } \
	  || true
	@tmp=$$(mktemp -d); $(NODE) scripts/run-unit-tests.mjs $$tmp >/dev/null 2>&1 \
	  && { rm -rf $$tmp; echo "FAIL: the unit suite reports success having run nothing"; exit 1; } \
	  || rm -rf $$tmp
	@echo "gate self-test: OK"

# Must fail. Invoked only by gate-selftest, which asserts that it does.
pipe-probe:
	@false | tee /dev/null

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
	@$(NODE) scripts/gen-rich-manifest.mjs
	@npx @vscode/vsce package --out dist/agent-conductor-rich.vsix; status=$$?; \
	  $(NODE) scripts/gen-rich-manifest.mjs --restore; \
	  exit $$status

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

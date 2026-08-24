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
# The VS Code CLI; `code-insiders` works too. Missing from PATH until VS Code's
# own "Shell Command: Install 'code' command in PATH" has been run once.
CODE  ?= code
REPORTS := reports
CORE_DIR ?= src/core
CORE_LOG ?= $(REPORTS)/core-imports.log
# What a seam forbids, so one checker serves every seam. Quoted `vscode` by
# default; the Shim additionally may not reach the core, and eslint's import
# patterns do not see a dynamic `import()` or a `createRequire` call.
CORE_PAT ?= ['\"\`]vscode['\"\`]

.DEFAULT_GOAL := help
.PHONY: help install doctor build watch lint typecheck core-imports gate-selftest pipe-probe \
        test test-integration smoke-live check check-all package install-plugin uninstall-plugin \
        release registry-cache adr plan clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: doctor ## Verify prerequisites, then install dependencies (ci when lockfile exists)
	@if [ -f package-lock.json ]; then $(NPM) ci; else $(NPM) install; fi

# The Node range lives in package.json's `engines.node` and is enforced here,
# before `install` runs: npm treats `engines` as advice and installs anyway, so
# the declaration alone gates nothing. `scripts/check-node.mjs` reads that one
# declaration, so there is no second copy of the range to drift.
doctor: ## Check required tools (node in engines.node, npm, git); report optional agent CLIs
	@ok=1; \
	for t in node npm git; do command -v $$t >/dev/null 2>&1 || { echo "MISSING: $$t"; ok=0; }; done; \
	if command -v node >/dev/null 2>&1; then \
	  node scripts/check-node.mjs || ok=0; \
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
	npx eslint src scripts --max-warnings 0 2>&1 | tee $(REPORTS)/eslint.log
	@$(MAKE) --no-print-directory core-imports
	@$(MAKE) --no-print-directory core-imports CORE_DIR=src/shim CORE_LOG=$(REPORTS)/shim-imports.log
	@$(MAKE) --no-print-directory core-imports CORE_DIR=src/shim CORE_LOG=$(REPORTS)/shim-core.log CORE_PAT='\.\..*core'

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
	@grep -rnE "$(CORE_PAT)" $(CORE_DIR) > $(CORE_LOG); \
	  case $$? in \
	    0) echo "FAIL: forbidden import inside $(CORE_DIR) (see $(CORE_LOG))"; exit 1 ;; \
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
	@tmp=$$(mktemp -d); rc=0; \
	  echo "Exit code:   0" > $$tmp/silent; \
	  printf '  0 passing (1ms)\n' > $$tmp/empty; \
	  for probe in silent empty; do \
	    $(NODE) scripts/report-integration.mjs $$tmp/$$probe 0 >/dev/null 2>&1 \
	      && { echo "FAIL: the extension-host gate passes a run that proved nothing ($$probe)"; rc=1; }; \
	  done; \
	  rm -rf $$tmp; test $$rc -eq 0
	@echo "gate self-test: OK"

# Must fail. Invoked only by gate-selftest, which asserts that it does.
pipe-probe:
	@false | tee /dev/null

test: ## Unit tests incl. mock-ACP-agent protocol tests → reports/test.log
	@mkdir -p $(REPORTS)
	$(NPM) test 2>&1 | tee $(REPORTS)/test.log

# The whole transcript goes to the log and the count comes back to the terminal.
# Not piped: a `tee` would put a VS Code window's own diagnostics back on the
# terminal this is keeping clear. The status is handed to the reporter rather
# than acted on here, because a run that exits zero having printed no count is
# also a failure, and only the reporter can see that.
test-integration: build ## VS Code extension host tests against the mock agent → reports/integration.log
	@mkdir -p $(REPORTS)
	@set +e; $(NPM) run test:integration > $(REPORTS)/integration.log 2>&1; status=$$?; \
	  set -e; $(NODE) scripts/report-integration.mjs $(REPORTS)/integration.log $$status

# Manual and optional by rule (PERSONAS.md): CI must not require installed CLIs,
# credentials, subscriptions, or network — so no check target reaches this.
smoke-live: ## Probe installed agent CLIs live, with the wizard's own Smoke Test (manual)
	$(NODE) --import tsx src/test/smoke-live.ts

check: build lint test ## Build + lint + unit tests
check-all: build lint test test-integration ## check + extension-host integration (release gate)

package: build ## Marketplace VSIX (stable APIs only)
	npx @vscode/vsce package --out dist/agent-conductor.vsix

# Local install of what this tree builds, for trying the extension in your own
# VS Code. `--force` reinstalls over the same version, which is every dev
# iteration. Publishing stays a human act; this touches one machine.
install-plugin: package ## Install the extension file into this machine's VS Code (reload the window after)
	@command -v $(CODE) >/dev/null 2>&1 || { echo "MISSING: $(CODE) — in VS Code run 'Shell Command: Install code command in PATH'"; exit 1; }
	$(CODE) --install-extension dist/agent-conductor.vsix --force
	@echo "installed — reload the VS Code window to load it"

uninstall-plugin: ## Remove the extension from this machine's VS Code
	@command -v $(CODE) >/dev/null 2>&1 || { echo "MISSING: $(CODE)"; exit 1; }
	$(CODE) --uninstall-extension $$($(NODE) -p "const p=require('./package.json'); p.publisher+'.'+p.name")

# There is no second, proposed-API package target. A manifest may only ask VS
# Code for a proposal this extension implements, and the sessions proposal is
# not implementable here yet — no proposed declarations to compile against and
# an extension-host gate that runs stable VS Code (ADR-0011).
release: ## Full gate + the VSIX; tagging/publishing stay human actions
	@git diff --quiet && git diff --cached --quiet || { echo "working tree dirty — commit first"; exit 1; }
	$(MAKE) check-all package
	@v=$$(node -p "require('./package.json').version"); \
	echo ""; echo "release artifact in dist/:"; ls -1 dist/*.vsix; \
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

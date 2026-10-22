.PHONY: lint test

LINT_FILES ?=
TEST_FILES ?=
export LINT_FILES := $(strip $(LINT_FILES))
export TEST_FILES := $(strip $(TEST_FILES))

# TypeScript checks the complete project graph even when devloop supplies files.
lint:
	@if [ -n "$$LINT_FILES" ]; then printf '%s\n' 'LINT_FILES supplied: expanding typecheck to the complete TypeScript project.'; fi
	npm run typecheck

test:
	node scripts/test-files.mjs

.PHONY: lint test

TEST_FILES ?=
export TEST_FILES := $(strip $(TEST_FILES))

# TypeScript checks the complete project graph.
lint:
	npm run typecheck

test:
	node scripts/test-files.mjs

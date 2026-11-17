.PHONY: lint test

LINT_FILES ?=
export LINT_FILES := $(strip $(LINT_FILES))

lint:
	@if [ -n "$$LINT_FILES" ]; then printf '%s\n' 'LINT_FILES supplied: expanding typecheck to the complete plugin project.'; fi
	npm run typecheck

# +spec=Plugin-only validation runs its host/runner/resource contract suite, not every Personal and Channel test.
# +rule=Component-relative selections must not leak into the repository-root runner.
PLUGIN_TEST_FILES := $(patsubst ../../%,%,$(sort $(wildcard ../../tests/plugin-*.test.ts ../../tests/runner-*.test.ts ../../tests/resource-*.test.ts)))
test:
	@test -n "$(PLUGIN_TEST_FILES)"
	$(MAKE) -C ../.. test TEST_FILES="$(PLUGIN_TEST_FILES)"

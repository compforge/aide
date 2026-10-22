.PHONY: lint test

LINT_FILES ?=
export LINT_FILES := $(strip $(LINT_FILES))

lint:
	@if [ -n "$$LINT_FILES" ]; then printf '%s\n' 'LINT_FILES supplied: expanding typecheck to the complete plugin project.'; fi
	npm run typecheck

# No package-local tests: contracts are exercised by the full host/runner suite.
# Component-relative selections must not leak into the root runner.
test:
	$(MAKE) -C ../.. test TEST_FILES=

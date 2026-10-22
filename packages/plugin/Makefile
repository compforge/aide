.PHONY: lint test

lint:
	npm run typecheck

# Plugin contracts are exercised by the repository's host/runner integration suite.
test:
	$(MAKE) -C ../.. test
